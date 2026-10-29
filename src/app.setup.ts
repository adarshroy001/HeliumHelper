import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { SchemaValidationPipe } from './common/validation/index.js';
import { appConfig, type AppConfig } from './config/index.js';
import { setupApiDocs } from './infrastructure/http/api-docs.js';
import { hardenHttp } from './infrastructure/http/http-hardening.js';

/** Options for creating the app, shared by `main.ts` and the HTTP test app. */
export const APP_OPTIONS = {
  // Nest's startup logs are held, then replayed through pino once configureApp attaches it.
  bufferLogs: true,
  // configureApp registers the one body parser (JSON, with a size limit).
  bodyParser: false,
  // Keep the exact request bytes in `req.rawBody`, for webhook signature checks.
  rawBody: true,
} satisfies NestApplicationOptions;

/**
 * Global app setup shared by `main.ts` and the HTTP test app, so tests run the same pipeline as production.
 * The exception filter is a provider (`HttpErrorsModule`), so it is part of `AppModule` and needs nothing here.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const config = app.get<AppConfig>(appConfig.KEY);

  app.useLogger(app.get(Logger));
  hardenHttp(app, config);
  app.useGlobalPipes(new SchemaValidationPipe());
  setupApiDocs(app, config);
  // SIGTERM (ECS stopping a task) closes the app: no new connections, in-flight requests finish, then exit.
  app.enableShutdownHooks();
  return app;
}
