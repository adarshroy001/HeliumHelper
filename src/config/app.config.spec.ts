import { describe, expect, it } from 'vitest';
import { parseAppConfig } from './app.config.js';
import { ConfigValidationError } from './config.loader.js';

const base = { NODE_ENV: 'development', APP_ENV: 'local' } as const;

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    parseAppConfig(env);
  } catch (err) {
    if (err instanceof ConfigValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected a ConfigValidationError');
}

describe('parseAppConfig', () => {
  it('applies defaults for optional variables', () => {
    expect(parseAppConfig(base)).toEqual({
      nodeEnv: 'development',
      appEnv: 'local',
      port: 3000,
      logLevel: 'info',
      name: 'helium-backend',
      corsOrigins: [],
      isProduction: false,
    });
  });

  it('reads CORS_ORIGINS as a comma-separated list', () => {
    const env = { ...base, CORS_ORIGINS: 'https://admin.heliumair.in, http://localhost:5173' };
    expect(parseAppConfig(env).corsOrigins).toEqual(['https://admin.heliumair.in', 'http://localhost:5173']);
  });

  it('coerces PORT from a string', () => {
    expect(parseAppConfig({ ...base, PORT: '8080' }).port).toBe(8080);
  });

  it('accepts a valid production setup', () => {
    const config = parseAppConfig({ NODE_ENV: 'production', APP_ENV: 'production', LOG_LEVEL: 'warn' });
    expect(config.isProduction).toBe(true);
  });

  it('reports every missing required variable at once', () => {
    expect(problemsOf({})).toEqual(['NODE_ENV: is required but not set', 'APP_ENV: is required but not set']);
  });

  it.each([
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['LOG_LEVEL', 'verbose'],
    ['APP_ENV', 'prod'],
    ['APP_NAME', ''],
    ['CORS_ORIGINS', 'https://admin.heliumair.in/'],
    ['CORS_ORIGINS', '*'],
  ])('rejects %s=%s', (key, value) => {
    const problems = problemsOf({ ...base, [key]: value });
    expect(problems).toHaveLength(1);
    // List items are reported by position, e.g. `CORS_ORIGINS.0: ...`.
    expect(problems[0]).toMatch(new RegExp(String.raw`^${key}(\.\d+)?:`));
  });

  it('requires NODE_ENV=production outside local', () => {
    expect(problemsOf({ NODE_ENV: 'development', APP_ENV: 'staging' })).toEqual([
      'NODE_ENV: must be "production" when APP_ENV is "staging"',
    ]);
  });

  it.each([['debug'], ['trace'], ['silent']])('refuses LOG_LEVEL=%s in production', (level) => {
    expect(problemsOf({ NODE_ENV: 'production', APP_ENV: 'production', LOG_LEVEL: level })).toEqual([
      'LOG_LEVEL: must be "info", "warn", "error" or "fatal" in production',
    ]);
  });

  it('allows debug logging in staging', () => {
    const config = parseAppConfig({ NODE_ENV: 'production', APP_ENV: 'staging', LOG_LEVEL: 'debug' });
    expect(config.logLevel).toBe('debug');
  });

  it('names the area and lists problems in the error message', () => {
    expect(() => parseAppConfig({ ...base, PORT: '0' })).toThrow(
      /^Invalid configuration \(app\):\n {2}- PORT: /,
    );
  });
});
