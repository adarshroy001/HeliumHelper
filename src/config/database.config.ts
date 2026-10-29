import { existsSync } from 'node:fs';
import { registerAs, type ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { loadConfig, type RawEnv } from './config.loader.js';

const mongoUri = z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/, 'must be a mongodb:// connection string');

/** Variables for the MongoDB connections (ADR-0005). */
export const databaseEnvSchema = z.object({
  /** Today's Helium database. The backend's user here is read-only. */
  MONGO_MAIN_URI: mongoUri,
  /** The messaging database (same cluster, separate database). */
  MONGO_MESSAGING_URI: mongoUri,
  /** Path to the DocumentDB CA bundle. When set, connections use TLS with it. Empty locally. */
  MONGO_TLS_CA_FILE: z
    .string()
    .default('')
    .refine((path) => path === '' || existsSync(path), 'file not found'),
  /** Most connections each named connection keeps open, per process. */
  MONGO_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(20),
});

/** Typed database config, built from the validated variables. */
export function parseDatabaseConfig(env: RawEnv) {
  const vars = loadConfig('database', databaseEnvSchema, env);
  return {
    mainUri: vars.MONGO_MAIN_URI,
    messagingUri: vars.MONGO_MESSAGING_URI,
    tlsCaFile: vars.MONGO_TLS_CA_FILE === '' ? undefined : vars.MONGO_TLS_CA_FILE,
    poolSize: vars.MONGO_POOL_SIZE,
  };
}

/** Inject with `@Inject(databaseConfig.KEY) private readonly db: DatabaseConfig`. */
export const databaseConfig = registerAs('database', () => parseDatabaseConfig(process.env));
export type DatabaseConfig = ConfigType<typeof databaseConfig>;
