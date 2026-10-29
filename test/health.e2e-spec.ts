import { Controller, Get, Module } from '@nestjs/common';
import { HealthCheckService, HealthIndicatorService, TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { Public } from '../src/common/auth/index.js';

/** Test-only readiness route with a dependency that is down, as F12+ checks will report it. */
@Public()
@Controller('probe-health')
class FailingHealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
  ) {}

  @Get('ready')
  ready() {
    return this.health.check([() => this.indicators.check('fakeDb').down({ reason: 'connection refused' })]);
  }
}

@Module({ imports: [AppModule, TerminusModule], controllers: [FailingHealthController] })
class FailingHealthModule {}

describe('health checks', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ module: FailingHealthModule });
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('reports the process as live', async () => {
    const res = await request(t.http).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports the process as ready when every dependency check passes', async () => {
    const res = await request(t.http).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      info: { mongoMain: { status: 'up' }, mongoMessaging: { status: 'up' } },
      error: {},
    });
  });

  it('returns 503 SERVICE_UNAVAILABLE, without dependency details, when a check fails', async () => {
    const res = await request(t.http).get('/probe-health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toStrictEqual({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'The service is not ready. Try again later.',
      requestId: res.headers['x-request-id'],
    });
  });

  it('returns 404 for an unknown route', async () => {
    const res = await request(t.http).get('/does-not-exist');

    expect(res.status).toBe(404);
  });
});
