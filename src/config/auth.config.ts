import { registerAs, type ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { loadConfig, type RawEnv } from './config.loader.js';

/** Variables for authenticating callers (ADR-0010). */
export const authEnvSchema = z.object({
  /**
   * The services allowed to call this backend and the secret each signs its tokens with, as JSON:
   * `{"helium-admin":"<secret>"}`. The key is the token's `iss`. In AWS it comes from Secrets Manager.
   */
  AUTH_CALLER_SECRETS: z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be JSON, such as {"helium-admin":"<secret>"}' });
        return z.NEVER;
      }
    })
    .pipe(
      z
        .record(
          z.string().regex(/^[a-z][a-z\d-]*$/),
          z.string().min(32, 'each secret needs 32 characters or more'),
        )
        .refine((callers) => Object.keys(callers).length > 0, 'must name at least one caller'),
    ),
});

/** Typed auth config, built from the validated variables. */
export function parseAuthConfig(env: RawEnv) {
  const vars = loadConfig('auth', authEnvSchema, env);
  return { callerSecrets: vars.AUTH_CALLER_SECRETS as Readonly<Record<string, string>> };
}

/** Inject with `@Inject(authConfig.KEY) private readonly auth: AuthConfig`. */
export const authConfig = registerAs('auth', () => parseAuthConfig(process.env));
export type AuthConfig = ConfigType<typeof authConfig>;
