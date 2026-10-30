import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { luaScript, runScript } from './scripts.js';

/** Deletes the lock only if it is still ours: after it expires, someone else may hold it. */
const releaseIfOwner = luaScript<number>({
  name: 'releaseLock',
  keys: 1,
  lua: `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
});

export interface Lock {
  readonly key: string;
  /** `false` if the lock had already expired (and may now belong to someone else). */
  release(): Promise<boolean>;
}

/**
 * Takes a lock on `key` for at most `ttlMs`, across every process, or returns `null` if someone holds it.
 * The TTL is the safety net if the holder dies: choose it longer than the work, and keep the work short.
 * Not a guarantee of mutual exclusion under every failure (Redis failover, long pauses); work protected by a
 * lock must still be idempotent (R10).
 */
export async function acquireLock(redis: Redis, key: string, ttlMs: number): Promise<Lock | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (result !== 'OK') return null;
  return {
    key,
    release: async () => (await runScript(redis, releaseIfOwner, [key], [token])) === 1,
  };
}
