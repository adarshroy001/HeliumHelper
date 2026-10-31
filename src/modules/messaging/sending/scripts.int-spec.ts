import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestRedis } from '../../../../test/helpers/redis.js';
import { runScript } from '../../../infrastructure/redis/index.js';
import { keys } from '../messaging.keys.js';
import { transition } from './counters.scripts.js';
import { maybeRaiseRate, onRateLimited, takeTokens } from './rate-limit.scripts.js';

describe('messaging Lua scripts (real Valkey)', () => {
  const clients: Redis[] = [];
  let redis: Redis;

  beforeAll(() => {
    // Several clients act as several sender processes.
    for (let i = 0; i < 5; i += 1) clients.push(connectTestRedis());
    redis = clients[0] as Redis;
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
  });

  const number = () => {
    const pn = randomUUID();
    return { pn, bucket: [keys.bucket(pn), keys.rate(pn), keys.numberPause(pn)] };
  };

  describe('takeTokens', () => {
    it('never grants more than the bucket holds, whatever the number of parallel callers', async () => {
      const { bucket } = number();
      const now = Date.now();

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          runScript(clients[i % clients.length] as Redis, takeTokens, bucket, [3, 1, 0.2, now, 80]),
        ),
      );

      expect(results.reduce((sum, [granted]) => sum + granted, 0)).toBe(80);
    });

    it('leaves the reserve for priority 1: campaign sends stop at 80% of the bucket', async () => {
      const { bucket } = number();
      const now = Date.now();

      const [campaign] = await runScript(redis, takeTokens, bucket, [100, 2, 0.2, now, 100]);
      const [moreCampaign, waitMs] = await runScript(redis, takeTokens, bucket, [10, 2, 0.2, now, 100]);
      const [direct] = await runScript(redis, takeTokens, bucket, [100, 1, 0.2, now, 100]);

      expect(campaign).toBe(80);
      expect(moreCampaign).toBe(0);
      expect(waitMs).toBeGreaterThan(0);
      expect(direct).toBe(20);
    });

    it('refills with time at the current rate', async () => {
      const { bucket } = number();
      const now = Date.now();
      await runScript(redis, takeTokens, bucket, [80, 1, 0, now, 80]);

      const [afterHalfSecond] = await runScript(redis, takeTokens, bucket, [80, 1, 0, now + 500, 80]);

      expect(afterHalfSecond).toBe(40);
    });

    it('grants nothing while the number is paused, and says how long to wait', async () => {
      const { pn, bucket } = number();
      await runScript(
        redis,
        onRateLimited,
        [keys.rate(pn), keys.numberPause(pn)],
        [0.7, 10, 2000, Date.now(), 80],
      );

      const [granted, waitMs] = await runScript(redis, takeTokens, bucket, [5, 1, 0.2, Date.now(), 80]);

      expect(granted).toBe(0);
      expect(waitMs).toBeGreaterThan(1500);
    });
  });

  describe('adaptive rate', () => {
    it('slows down by 30% per rate limit, never below the floor, then climbs back after quiet spells', async () => {
      const { pn } = number();
      const limit = (now: number) =>
        runScript(redis, onRateLimited, [keys.rate(pn), keys.numberPause(pn)], [0.7, 10, 0, now, 80]);

      expect(await limit(1000)).toBe(56);
      expect(await limit(1001)).toBe(39);
      for (let i = 0; i < 10; i += 1) await limit(1002 + i);
      expect(await limit(1100)).toBe(10);

      expect(await runScript(redis, maybeRaiseRate, [keys.rate(pn)], [1.05, 80, 30_000, 20_000])).toBe(10);
      expect(await runScript(redis, maybeRaiseRate, [keys.rate(pn)], [1.05, 80, 30_000, 31_100])).toBe(10);
      expect(await runScript(redis, maybeRaiseRate, [keys.rate(pn)], [1.05, 80, 30_000, 61_200])).toBe(11);
    });

    it('uses the lowered rate for the bucket', async () => {
      const { pn, bucket } = number();
      await runScript(
        redis,
        onRateLimited,
        [keys.rate(pn), keys.numberPause(pn)],
        [0.5, 10, 0, Date.now(), 80],
      );

      const [granted] = await runScript(redis, takeTokens, bucket, [100, 1, 0, Date.now(), 80]);

      expect(granted).toBe(40);
    });
  });

  describe('transition', () => {
    const campaign = () => {
      const id = randomUUID();
      const step = (deliveryId: string, status: string) =>
        runScript(redis, transition, [keys.ranks(id), keys.counters(id)], [deliveryId, status]);
      const counters = async () => redis.hgetall(keys.counters(id));
      return { step, counters };
    };

    it('counts each state once per delivery, through duplicates and reordering', async () => {
      const { step, counters } = campaign();

      await step('d1', 'accepted');
      await step('d1', 'delivered');
      await step('d1', 'sent');
      await step('d1', 'delivered');
      await step('d2', 'read');

      expect(await counters()).toEqual({ accepted: '2', sent: '2', delivered: '2', read: '1' });
    });

    it('counts failed after sent, but not after delivered, and nothing after failed', async () => {
      const { step, counters } = campaign();

      expect(await step('d1', 'sent')).toEqual([1, 0]);
      expect(await step('d1', 'failed')).toEqual([1, 2]);
      expect(await step('d1', 'delivered')).toEqual([0, -1]);
      await step('d2', 'delivered');
      expect(await step('d2', 'failed')).toEqual([0, 3]);

      expect(await counters()).toMatchObject({ failed: '1', delivered: '1' });
    });

    it('skips only pending deliveries', async () => {
      const { step, counters } = campaign();

      await step('d1', 'skipped');
      await step('d1', 'skipped');
      await step('d2', 'accepted');
      await step('d2', 'skipped');

      expect(await counters()).toEqual({ skipped: '1', accepted: '1' });
    });
  });
});
