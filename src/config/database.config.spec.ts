import { describe, expect, it } from 'vitest';
import { ConfigValidationError } from './config.loader.js';
import { parseDatabaseConfig } from './database.config.js';

const base = {
  MONGO_MAIN_URI: 'mongodb://localhost:27017/helium',
  MONGO_MESSAGING_URI: 'mongodb://localhost:27017/helium_messaging',
};

function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    parseDatabaseConfig(env);
  } catch (err) {
    if (err instanceof ConfigValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected a ConfigValidationError');
}

describe('parseDatabaseConfig', () => {
  it('reads both connections, with defaults', () => {
    expect(parseDatabaseConfig(base)).toEqual({
      mainUri: base.MONGO_MAIN_URI,
      messagingUri: base.MONGO_MESSAGING_URI,
      tlsCaFile: undefined,
      poolSize: 20,
    });
  });

  it('accepts an SRV connection string and an existing CA file', () => {
    const env = {
      ...base,
      MONGO_MAIN_URI: 'mongodb+srv://cluster.example.net/helium',
      MONGO_TLS_CA_FILE: 'package.json',
    };

    expect(parseDatabaseConfig(env)).toMatchObject({ tlsCaFile: 'package.json' });
  });

  it.each([
    ['MONGO_MAIN_URI', undefined, /is required but not set/],
    ['MONGO_MESSAGING_URI', 'postgres://localhost/db', /mongodb:\/\//],
    ['MONGO_TLS_CA_FILE', 'missing/global-bundle.pem', /file not found/],
    ['MONGO_POOL_SIZE', '0', /MONGO_POOL_SIZE/],
  ])('rejects %s=%s', (key, value, problem) => {
    const problems = problemsOf({ ...base, [key]: value });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(problem);
  });
});
