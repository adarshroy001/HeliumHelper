import { Controller, Get, Module } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Public, RequirePermissions } from '../src/common/auth/index.js';
import { createTestApp } from './helpers/create-test-app.js';
import { routesWithoutAccessDecision } from './helpers/route-access.js';

/**
 * Route coverage (ADR-0010, R7): every route of the real app declares who may call it. A failure lists the
 * routes to fix: add `@Public()` or `@RequirePermissions(...)`.
 */
describe('route access coverage', () => {
  it('every route of the app declares @Public() or @RequirePermissions()', async () => {
    const { app } = await createTestApp();

    expect(routesWithoutAccessDecision(app)).toEqual([]);

    await app.close();
  });

  it('finds a route that declares neither', async () => {
    @Public()
    @Controller('a')
    class PublicController {
      @Get()
      get(): void {}
    }

    @Controller('b')
    class MixedController {
      @Get('allowed')
      @RequirePermissions('things:read')
      allowed(): void {}

      @Get('forgotten')
      forgotten(): void {}

      helper(): void {}
    }

    @Module({ imports: [AppModule], controllers: [PublicController, MixedController] })
    class ProbeModule {}

    const { app } = await createTestApp({ module: ProbeModule });

    expect(routesWithoutAccessDecision(app)).toEqual(['MixedController.forgotten']);

    await app.close();
  });
});
