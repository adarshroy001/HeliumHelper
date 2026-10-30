import { registerAs, type ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { loadConfig, type RawEnv } from './config.loader.js';

/** Variables for Redis (Valkey), used for coordination only (ADR-0007). */
export const redisEnvSchema = z.object({
  /** `redis://host:6379` locally; `rediss://` (TLS) for ElastiCache. */
  REDIS_URL: z.string().regex(/^rediss?:\/\/\S+$/, 'must be a redis:// or rediss:// URL'),
  /** ElastiCache auth token, from Secrets Manager. Empty locally. */
  REDIS_AUTH_TOKEN: z.string().default(''),
});

/** Typed Redis config, built from the validated variables. */
export function parseRedisConfig(env: RawEnv) {
  const vars = loadConfig('redis', redisEnvSchema, env);
  return {
    url: vars.REDIS_URL,
    authToken: vars.REDIS_AUTH_TOKEN === '' ? undefined : vars.REDIS_AUTH_TOKEN,
    tls: vars.REDIS_URL.startsWith('rediss://'),
  };
}

/** Inject with `@Inject(redisConfig.KEY) private readonly redis: RedisConfig`. */
export const redisConfig = registerAs('redis', () => parseRedisConfig(process.env));
export type RedisConfig = ConfigType<typeof redisConfig>;
