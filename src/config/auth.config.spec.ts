import { describe, expect, it } from 'vitest';
import { parseAuthConfig } from './auth.config.js';
import { ConfigValidationError } from './config.loader.js';

const SECRET = 'x'.repeat(32);

function problemsOf(value: string | undefined): readonly string[] {
  try {
    parseAuthConfig({ AUTH_CALLER_SECRETS: value });
  } catch (err) {
    if (err instanceof ConfigValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected a ConfigValidationError');
}

describe('parseAuthConfig', () => {
  it('reads each caller and its secret', () => {
    const env = { AUTH_CALLER_SECRETS: JSON.stringify({ 'helium-admin': SECRET, 'ops-bot': SECRET }) };

    expect(parseAuthConfig(env).callerSecrets).toEqual({ 'helium-admin': SECRET, 'ops-bot': SECRET });
  });

  it.each([
    ['missing', undefined, /is required but not set/],
    ['not JSON', 'helium-admin=abc', /must be JSON/],
    ['no callers', '{}', /at least one caller/],
    ['a short secret', JSON.stringify({ 'helium-admin': 'short' }), /32 characters/],
    ['a bad caller name', JSON.stringify({ 'Helium Admin': SECRET }), /AUTH_CALLER_SECRETS/],
  ])('rejects %s', (_case, value, problem) => {
    const problems = problemsOf(value);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(problem);
    expect(problems.join()).not.toContain(SECRET);
  });
});
