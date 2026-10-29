import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { appConfig, type AppConfig } from './config/index.js';

async function bootstrap(): Promise<void> {
  // abortOnError: false — let startup errors (such as invalid config) reach the handler below,
  // which logs them in full, instead of Nest exiting on its own.
  const app = configureApp(await NestFactory.create(AppModule, { abortOnError: false }));
  const config = app.get<AppConfig>(appConfig.KEY);

  await app.listen(config.port);
  Logger.log(`${config.name} listening on port ${String(config.port)} (${config.appEnv})`, 'Bootstrap');
}

// A failed start ends the process so the platform restarts it, instead of leaving it up without a listener.
bootstrap().catch((err: unknown) => {
  Logger.error(err instanceof Error ? err.message : err, 'Bootstrap');
  process.exit(1);
});
