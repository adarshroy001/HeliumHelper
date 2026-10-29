import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { APP_OPTIONS, configureApp } from './app.setup.js';
import { appConfig, type AppConfig } from './config/index.js';
import { createProcessLogger, exitOnUncaughtErrors } from './infrastructure/logger/process-logger.js';

const processLogger = createProcessLogger();
exitOnUncaughtErrors(processLogger);

async function bootstrap(): Promise<void> {
  const app = configureApp(
    await NestFactory.create<NestExpressApplication>(AppModule, {
      ...APP_OPTIONS,
      // Nest stays silent until pino takes over in configureApp. Otherwise a failed start is printed twice:
      // once by Nest in plain text, once by the handler below.
      logger: false,
      // Startup errors reach the handler below instead of Nest aborting the process itself.
      abortOnError: false,
    }),
  );
  const config = app.get<AppConfig>(appConfig.KEY);
  processLogger.setBindings({ service: config.name, env: config.appEnv });

  await app.listen(config.port);
  Logger.log(`${config.name} listening on port ${String(config.port)} (${config.appEnv})`, 'Bootstrap');
}

// A failed start ends the process so the platform restarts it, instead of leaving it up without a listener.
bootstrap().catch((err: unknown) => {
  processLogger.fatal({ err }, 'startup failed');
  process.exit(1);
});
