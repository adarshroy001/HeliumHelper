import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { AppConfig } from '../../config/index.js';

export const API_DOCS_PATH = 'docs';

/**
 * Serves the OpenAPI document at `/docs` (UI) and `/docs-json`, except in production.
 * Request schemas come from the zod schemas on `@Body`, `@Query` and `@Param`: zod implements Standard JSON
 * Schema, which `@nestjs/swagger` reads directly, so limits, defaults and `additionalProperties: false` appear
 * without any extra decorators.
 */
export function setupApiDocs(app: INestApplication, config: AppConfig): void {
  if (config.isProduction) return;

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle(config.name).setDescription('Helium backend API').build(),
  );
  SwaggerModule.setup(API_DOCS_PATH, app, document);
}
