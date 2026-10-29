import { registerAs, type ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { loadConfig, type RawEnv } from './config.loader.js';

/** Variables for the app itself. Every variable here must also appear in `.env.example` (enforced by a test). */
export const appEnvSchema = z
  .object({
    /** How Node and libraries behave: `production` turns on their production behaviour. */
    NODE_ENV: z.enum(['development', 'test', 'production']),
    /** Which deployment this is. Staging runs with NODE_ENV=production but APP_ENV=staging. */
    APP_ENV: z.enum(['local', 'staging', 'production']),
    /** Port the API listens on. */
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    /** Minimum log level. */
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Service name shown in logs and metrics. */
    APP_NAME: z.string().min(1).default('helium-backend'),
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
    // Debug-level logs are too verbose and too likely to contain customer data for production.
    if (env.APP_ENV === 'production' && (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace')) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_LEVEL'],
        message: 'must be "info" or quieter in production',
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
    isProduction: vars.APP_ENV === 'production',
  };
}

/**
 * Inject with `@Inject(appConfig.KEY) private readonly app: AppConfig`.
 * The factory runs once at startup; an invalid environment stops the app before it serves anything.
 */
export const appConfig = registerAs('app', () => parseAppConfig(process.env));
export type AppConfig = ConfigType<typeof appConfig>;
