import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { appConfig } from './app.config.js';
import { authConfig } from './auth.config.js';
import { databaseConfig } from './database.config.js';
import { queueConfig } from './queue.config.js';
import { redisConfig } from './redis.config.js';
import { workerConfig } from './worker.config.js';

/** Every config area. Add a new area's `registerAs(...)` here and its schema to `CONFIG_SCHEMAS`. */
export const CONFIG_AREAS = [appConfig, authConfig, databaseConfig, redisConfig, queueConfig, workerConfig];

/**
 * Loads `.env.local` then `.env` for local development (real environment variables win),
 * then validates every area at startup. Tests (NODE_ENV=test, set by Vitest) never read env files,
 * so a developer's `.env` can't change test results.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: CONFIG_AREAS,
      envFilePath: ['.env.local', '.env'],
      ignoreEnvFile: process.env['NODE_ENV'] === 'test',
    }),
  ],
})
export class ConfigModule {}
