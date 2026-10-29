import { registerAs, type ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { loadConfig, type RawEnv } from './config.loader.js';

/** A browser origin: scheme and host, optional port, no path. */
const ORIGIN = /^https?:\/\/[a-z\d.-]+(:\d{1,5})?$/;

/** Variables for the app itself. Every variable here must also appear in `.env.example` (enforced by a test). */
export const appEnvSchema = z
  .object({
    /** How Node and libraries behave: `production` turns on their production behaviour. */
    NODE_ENV: z.enum(['development', 'test', 'production']),
    /** Which deployment this is. Staging runs with NODE_ENV=production but APP_ENV=staging. */
    APP_ENV: z.enum(['local', 'staging', 'production']),
    /** Port the API listens on. */
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    /** Minimum log level. `silent` turns logging off (tests). */
    LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Service name shown in logs and metrics. */
    APP_NAME: z.string().min(1).default('helium-backend'),
    /** Browser origins allowed to call the API, comma-separated. Empty: no browser may call it. */
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(ORIGIN, 'must be an origin such as https://admin.example.com'))),
  })
  .superRefine((env, ctx) => {
    // Deployed environments must run Node in production mode.
    if (env.APP_ENV !== 'local' && env.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['NODE_ENV'],
        message: `must be "production" when APP_ENV is "${env.APP_ENV}"`,
      });
    }
    // Production needs logs, but not debug-level ones: too verbose and too likely to hold customer data.
    if (env.APP_ENV === 'production' && ['silent', 'debug', 'trace'].includes(env.LOG_LEVEL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_LEVEL'],
        message: 'must be "info", "warn", "error" or "fatal" in production',
      });
    }
  });

/** Typed app config, built from the validated variables. */
export function parseAppConfig(env: RawEnv) {
  const vars = loadConfig('app', appEnvSchema, env);
  return {
    nodeEnv: vars.NODE_ENV,
    appEnv: vars.APP_ENV,
    port: vars.PORT,
    logLevel: vars.LOG_LEVEL,
    name: vars.APP_NAME,
    corsOrigins: vars.CORS_ORIGINS,
    isProduction: vars.APP_ENV === 'production',
  };
}

/**
 * Inject with `@Inject(appConfig.KEY) private readonly app: AppConfig`.
 * The factory runs once at startup; an invalid environment stops the app before it serves anything.
 */
export const appConfig = registerAs('app', () => parseAppConfig(process.env));
export type AppConfig = ConfigType<typeof appConfig>;
