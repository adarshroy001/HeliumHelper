import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

describe('RedisThrottlerStorage', () => {
  it('lets requests through and warns once while Redis is down', async () => {
    const down = {
      defineCommand: vi.fn(),
      luaRateLimitHit: vi.fn().mockRejectedValue(new Error('Connection is closed.')),
    } as unknown as Redis;
    const warn = vi.fn();
    const logger = { warn } as unknown as PinoLogger;
    const storage = new RedisThrottlerStorage(down, logger);

    const first = await storage.increment('k', 60_000, 2, 60_000, 'internal');
    await storage.increment('k', 60_000, 2, 60_000, 'internal');

    expect(first).toEqual({ totalHits: 0, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
