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
