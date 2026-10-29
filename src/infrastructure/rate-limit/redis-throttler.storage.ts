import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import { redisKey } from '../redis/keys.js';
import { luaScript, runScript } from '../redis/scripts.js';

/**
 * Counts one hit in a fixed window and blocks the caller once over the limit, in one atomic step.
 * KEYS: hits, block. ARGV: window ms, limit, block ms. Returns { hits, window ms left, blocked (0/1), block ms left }.
 */
const hit = luaScript<[number, number, number, number]>({
  name: 'rateLimitHit',
  keys: 2,
  lua: `local blockLeft = redis.call('pttl', KEYS[2])
if blockLeft > 0 then
  return { tonumber(redis.call('get', KEYS[1]) or ARGV[2]), redis.call('pttl', KEYS[1]), 1, blockLeft }
end
local hits = redis.call('incr', KEYS[1])
if hits == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end
local windowLeft = redis.call('pttl', KEYS[1])
if hits > tonumber(ARGV[2]) then
  redis.call('set', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, windowLeft, 1, tonumber(ARGV[3]) }
end
return { hits, windowLeft, 0, 0 }`,
});

const toSeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/** Warn about an outage at most this often, not on every request. */
const WARN_EVERY_MS = 60_000;

/**
 * Throttler storage shared by every API instance, so a limit is the same however many instances run
 * (in-memory limits multiply with each one).
 *
 * When Redis is down, requests are let through (fail open) and a warning is logged at most once a minute:
 * a rate limiter must not take the API down with it. Readiness turns red at the same time.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private lastWarned = 0;

  constructor(
    private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    try {
      const [totalHits, windowLeft, blocked, blockLeft] = await runScript(
        this.redis,
        hit,
        [
          redisKey('rate-limit', `${throttlerName}-hits`, key),
          redisKey('rate-limit', `${throttlerName}-block`, key),
        ],
        [ttl, limit, blockDuration],
      );
      return {
        totalHits,
        timeToExpire: toSeconds(windowLeft),
        isBlocked: blocked === 1,
        timeToBlockExpire: toSeconds(blockLeft),
      };
    } catch (err) {
      if (Date.now() - this.lastWarned > WARN_EVERY_MS) {
        this.lastWarned = Date.now();
        this.logger.warn({ err }, 'rate limiting is off: Redis is unavailable');
      }
      return { totalHits: 0, timeToExpire: toSeconds(ttl), isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
