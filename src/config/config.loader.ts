import type { z } from 'zod';

/** Startup fails with this when any configuration value is missing or invalid. Lists every problem at once. */
export class ConfigValidationError extends Error {
  constructor(
    readonly area: string,
    readonly problems: readonly string[],
  ) {
    super(`Invalid configuration (${area}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/** Raw environment, as given by the process or a test. */
export type RawEnv = Readonly<Record<string, string | undefined>>;

/**
 * Validates one area's variables with its zod schema and returns the typed result.
 * The only place that reads raw environment values; feature code receives typed config (CONVENTIONS R12).
 */
export function loadConfig<S extends z.ZodType>(area: string, schema: S, env: RawEnv): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join('.') || '(root)';
    // zod reports a missing enum value as "invalid option"; say plainly that it isn't set.
    const notSet = issue.path.length === 1 && env[key] === undefined;
    return notSet ? `${key}: is required but not set` : `${key}: ${issue.message}`;
  });
  throw new ConfigValidationError(area, problems);
}
