import type { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

/**
 * Global app setup shared by `main.ts` and the HTTP test app, so tests run the same pipeline as production.
 * The app must be created with `bufferLogs: true` so startup logs also go through pino.
 * Later tasks add the exception filter (F8), validation (F9) and HTTP hardening (F10) here.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  return app;
}
