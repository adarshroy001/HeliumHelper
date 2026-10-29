import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create(AppModule));

  // Read directly until the typed config module replaces it (task F6).
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  Logger.log(`API listening on port ${String(port)}`, 'Bootstrap');
}

// A failed start ends the process so the platform restarts it, instead of leaving it up without a listener.
bootstrap().catch((err: unknown) => {
  Logger.error(err, 'Bootstrap');
  process.exit(1);
});
