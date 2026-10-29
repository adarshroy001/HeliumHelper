import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { SchemaValidationPipe } from './common/validation/index.js';
import { appConfig, type AppConfig } from './config/index.js';
import { setupApiDocs } from './infrastructure/http/api-docs.js';

/**
 * Global app setup shared by `main.ts` and the HTTP test app, so tests run the same pipeline as production.
 * The app must be created with `bufferLogs: true` so startup logs also go through pino.
 * HTTP hardening (F10) is added here later. The exception filter is a provider (`HttpErrorsModule`), so it is
 * part of `AppModule` and needs nothing here.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new SchemaValidationPipe());
  setupApiDocs(app, app.get<AppConfig>(appConfig.KEY));
  app.enableShutdownHooks();
  return app;
}
