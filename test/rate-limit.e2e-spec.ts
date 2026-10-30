import { randomUUID } from 'node:crypto';
import { Controller, Get, Module } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Public, RequirePermissions, ROLE_PERMISSIONS } from '../src/common/auth/index.js';
import { InternalController } from '../src/common/http/index.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { signToken } from './helpers/tokens.js';

/** Test-only route with a small limit, so tests can exceed it. */
@InternalController('reports')
@RequirePermissions('reports:read')
class ReportsController {
  @Get()
  @Throttle({ internal: { limit: 2, ttl: 60_000 } })
  list(): { ok: true } {
    return { ok: true };
  }
}

/** Outside every audience prefix: never limited, whatever it declares. */
@Public()
@Controller('outside')
class OutsideController {
  @Get()
  @Throttle({ internal: { limit: 1, ttl: 60_000 } })
  get(): { ok: true } {
    return { ok: true };
  }
}

@Module({ imports: [AppModule], controllers: [ReportsController, OutsideController] })
class ReportsModule {}

describe('rate limiting', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      module: ReportsModule,
      override: (b) => b.overrideProvider(ROLE_PERMISSIONS).useValue({ analyst: ['reports:read'] }),
    });
  });

  afterAll(async () => {
    await t.app.close();
  });

  /** A token for a new user, so each test starts with a fresh budget in the shared Redis. */
  const newUser = () =>
    signToken({ act: { id: randomUUID(), email: 'asha@heliumair.in', roles: ['analyst'] } });
  const list = (token: string) =>
    request(t.http).get('/internal/v1/reports').set('Authorization', `Bearer ${token}`);

  it('returns 429 RATE_LIMITED, in the standard error shape, once a caller exceeds the limit', async () => {
    const token = await newUser();
    expect((await list(token)).status).toBe(200);
    expect((await list(token)).status).toBe(200);

    const res = await list(token);

    expect(res.status).toBe(429);
    expect(res.body).toStrictEqual({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: 'Too many requests. Try again later.',
      details: { retryAfterSeconds: expect.any(Number) as unknown },
      requestId: res.headers['x-request-id'],
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts each caller separately', async () => {
    const first = await newUser();
    for (let i = 0; i < 3; i += 1) await list(first);

    expect((await list(await newUser())).status).toBe(200);
  });

  it('never limits routes outside the audience prefixes', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await request(t.http).get('/outside')).status).toBe(200);
    }
  });
});
