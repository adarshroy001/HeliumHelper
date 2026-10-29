import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { AppConfig } from '../../config/index.js';

/** Largest request body accepted. Bigger uploads (contact lists) go to S3, not through the API. */
export const BODY_LIMIT = '1mb';

/**
 * - Security headers (helmet), and no `X-Powered-By`.
 * - CORS only for the origins in `CORS_ORIGINS`. With none, browsers can't call the API.
 * - JSON bodies only, up to `BODY_LIMIT`. With `rawBody: true` in the app options, `req.rawBody` keeps the exact
 *   bytes for webhook signature checks.
 */
export function hardenHttp(app: NestExpressApplication, config: AppConfig): void {
  app.use(helmet());
  if (config.corsOrigins.length > 0) {
    app.enableCors({ origin: config.corsOrigins, maxAge: 600 });
  }
  app.useBodyParser('json', { limit: BODY_LIMIT });
}
