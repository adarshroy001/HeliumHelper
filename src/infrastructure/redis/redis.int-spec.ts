import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestRedis } from '../../../test/helpers/redis.js';
import { acquireLock, luaScript, redisKey, runScript } from './index.js';

/** Adds to a counter and sets its expiry in one atomic step. */
const addWithExpiry = luaScript<number>({
  name: 'testAddWithExpiry',
  keys: 1,
  lua: `local value = redis.call('incrby', KEYS[1], ARGV[1])
redis.call('pexpire', KEYS[1], ARGV[2])
return value`,
});

describe('Redis helpers (real Valkey)', () => {
  let a: Redis;
  let b: Redis;
  const key = (purpose: string) => redisKey('test', purpose, randomUUID());

  beforeAll(() => {
    // Two clients, as two processes would have.
    a = connectTestRedis();
    b = connectTestRedis();
  });

  afterAll(async () => {
    await Promise.all([a.quit(), b.quit()]);
  });

  describe('runScript', () => {
    it('runs a script atomically, with keys and arguments passed in', async () => {
      const counter = key('counter');

      expect(await runScript(a, addWithExpiry, [counter], [5, 60_000])).toBe(5);
      expect(await runScript(b, addWithExpiry, [counter], [2, 60_000])).toBe(7);
      expect(await a.pttl(counter)).toBeGreaterThan(50_000);
    });

    it('still runs after Redis forgets its scripts (restart or failover)', async () => {
      const counter = key('counter');
      await runScript(a, addWithExpiry, [counter], [1, 60_000]);

      await a.script('FLUSH');

      expect(await runScript(a, addWithExpiry, [counter], [1, 60_000])).toBe(2);
    });

    it('refuses the wrong number of keys, and two scripts with one name', async () => {
      await expect(runScript(a, addWithExpiry, [], [1, 1000])).rejects.toThrow(/takes 1 keys, got 0/);

      const impostor = luaScript<number>({ name: 'testAddWithExpiry', keys: 1, lua: 'return 0' });
      await expect(runScript(a, impostor, [key('x')])).rejects.toThrow(/Two different scripts/);
    });
  });

  describe('acquireLock', () => {
    it('lets one client hold a lock at a time', async () => {
      const lockKey = key('lock');

      const first = await acquireLock(a, lockKey, 10_000);
      expect(first).not.toBeNull();
      expect(await acquireLock(b, lockKey, 10_000)).toBeNull();

      expect(await first?.release()).toBe(true);
      expect(await acquireLock(b, lockKey, 10_000)).not.toBeNull();
    });

    it('never releases a lock that expired and was taken by someone else', async () => {
      const lockKey = key('lock');
      const stale = await acquireLock(a, lockKey, 50);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await acquireLock(b, lockKey, 10_000);

      expect(await stale?.release()).toBe(false);
      expect(await b.exists(lockKey)).toBe(1);
      expect(await current?.release()).toBe(true);
    });
  });
});
