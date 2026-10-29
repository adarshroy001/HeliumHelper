import 'reflect-metadata';
import type { Server } from 'node:http';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { APP_OPTIONS, configureApp } from '../../src/app.setup.js';

export interface CreateTestAppOptions {
  /** Root module to boot. Defaults to the real `AppModule`. */
  module?: Type;
  /** Replace providers before compiling, e.g. `(b) => b.overrideProvider(X).useValue(fake)`. */
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export interface TestApp {
  app: NestExpressApplication;
  /** The underlying HTTP server, typed for supertest: `request(http)`. */
  http: Server;
}

/**
 * Boots the app the way `main.ts` does (same `configureApp`), without listening on a port.
 * Always `await app.close()` in `afterAll`.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [options.module ?? AppModule] });
  const moduleRef = await (options.override ? options.override(builder) : builder).compile();
  const app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
  await app.init();
  return { app, http: app.getHttpServer() };
}
