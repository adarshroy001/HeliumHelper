import { Redis } from 'ioredis';

/**
 * A new client for the test run's Valkey. Call it twice to act as two processes. Use unique keys
 * (`redisKey(..., randomUUID())`), because test files share the server. Call `quit()` in `afterAll`.
 */
export function connectTestRedis(): Redis {
  const url = process.env['REDIS_URL'];
  if (url === undefined) throw new Error('REDIS_URL is not set: run this through the int or e2e project');
  return new Redis(url);
}

/**
 * Points the app at a Redis database of its own (Valkey has 16, numbered 0–15), so test files running in parallel
 * never share keys, such as an account's pause flag or a number's rate. Call it before creating the app; restore
 * `process.env` afterwards. Give each test file a different number; 0 is the shared default.
 */
export function isolatedRedis(database: number): void {
  const url = process.env['REDIS_URL'];
  if (url === undefined) throw new Error('REDIS_URL is not set: run this through the int or e2e project');
  const parsed = new URL(url);
  parsed.pathname = `/${String(database)}`;
  process.env['REDIS_URL'] = parsed.toString();
}
