import type { INestApplication } from '@nestjs/common';

/**
 * Global app setup shared by `main.ts` and the HTTP test app, so tests run the same pipeline as production.
 * Later tasks add the exception filter (F8), validation (F9) and HTTP hardening (F10) here.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.enableShutdownHooks();
  return app;
}
