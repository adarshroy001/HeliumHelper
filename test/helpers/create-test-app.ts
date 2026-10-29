import 'reflect-metadata';
import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';

export interface CreateTestAppOptions {
  /** Root module to boot. Defaults to the real `AppModule`. */
  module?: Type;
  /** Replace providers before compiling, e.g. `(b) => b.overrideProvider(X).useValue(fake)`. */
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export interface TestApp {
  app: INestApplication;
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
  const app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
  await app.init();
  // Nest types the server as `any`; with the Express adapter it is a Node HTTP server.
  return { app, http: app.getHttpServer() as Server };
}
