import { describe, expect, it } from 'vitest';
import { ConfigValidationError } from './config.loader.js';
import { parseRedisConfig } from './redis.config.js';

describe('parseRedisConfig', () => {
  it('reads a local URL without auth', () => {
    expect(parseRedisConfig({ REDIS_URL: 'redis://localhost:6379' })).toEqual({
      url: 'redis://localhost:6379',
      authToken: undefined,
      tls: false,
    });
  });

  it('turns on TLS for rediss:// and keeps the auth token', () => {
    const config = parseRedisConfig({
      REDIS_URL: 'rediss://cache.example.com:6379',
      REDIS_AUTH_TOKEN: 'tok',
    });

    expect(config).toMatchObject({ tls: true, authToken: 'tok' });
  });

  it.each([undefined, 'http://localhost:6379'])('rejects REDIS_URL=%s', (value) => {
    expect(() => parseRedisConfig({ REDIS_URL: value })).toThrow(ConfigValidationError);
  });
});
