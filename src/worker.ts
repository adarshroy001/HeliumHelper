import 'reflect-metadata';
import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { APP_OPTIONS } from './app.setup.js';
import { appConfig, type AppConfig, workerConfig, type WorkerConfig } from './config/index.js';
import { createProcessLogger, exitOnUncaughtErrors } from './infrastructure/logger/process-logger.js';
import { WorkerModule } from './worker.module.js';

const processLogger = createProcessLogger();
exitOnUncaughtErrors(processLogger);

/**
 * The worker process (ADR-0006): runs the consumers `WORKER_QUEUES` names, and serves only `/health/*` on
 * `WORKER_HEALTH_PORT`. On SIGTERM it stops receiving, finishes in-flight messages and exits.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(WorkerModule, {
    ...APP_OPTIONS,
    // As in main.ts: Nest stays silent until pino takes over, so a failed start is logged once.
    logger: false,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(appConfig.KEY);
  const worker = app.get<WorkerConfig>(workerConfig.KEY);
  processLogger.setBindings({ service: config.name, env: config.appEnv });

  await app.listen(worker.healthPort);
  NestLogger.log(`worker health on port ${String(worker.healthPort)} (${config.appEnv})`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  processLogger.fatal({ err }, 'startup failed');
  process.exit(1);
});
