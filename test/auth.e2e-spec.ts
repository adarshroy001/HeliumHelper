import { Get, Module } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  type Actor,
  CurrentActor,
  Public,
  RequirePermissions,
  ROLE_PERMISSIONS,
  type RolePermissions,
} from '../src/common/auth/index.js';
import { InternalController } from '../src/common/http/index.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { LogCapture } from './helpers/log-capture.js';
import { signToken } from './helpers/tokens.js';

/** Test-only routes, one per kind of access decision. */
@InternalController('reports')
class ReportsController {
  @Get()
  @RequirePermissions('reports:read')
  list(@CurrentActor() actor: Actor): Actor {
    return actor;
  }

  @Get('open')
  @Public()
  open(): { open: true } {
    return { open: true };
  }

  @Get('undeclared')
  undeclared(): { reached: true } {
    return { reached: true };
  }
}

@Module({ imports: [AppModule], controllers: [ReportsController] })
class ReportsModule {}

const ROLES: RolePermissions = { analyst: ['reports:read'], viewer: ['dashboards:read'] };
const analyst = { id: 'u1', email: 'asha@heliumair.in', roles: ['analyst'] };
const now = () => Math.floor(Date.now() / 1000);

describe('authentication and access control', () => {
  const capture = new LogCapture();
  let t: TestApp;

  beforeAll(async () => {
    process.env['LOG_LEVEL'] = 'info';
    t = await createTestApp({
      module: ReportsModule,
      override: (b) => capture.override(b).overrideProvider(ROLE_PERMISSIONS).useValue(ROLES),
    });
  });

  afterAll(async () => {
    await t.app.close();
    process.env['LOG_LEVEL'] = 'silent';
  });

  const get = (path: string, token?: string) => {
    const req = request(t.http).get(`/internal/v1/reports${path}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  it('allows a caller whose user has the permission, and passes the actor to the handler', async () => {
    const res = await get('', await signToken({ act: analyst }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ service: 'helium-admin', user: analyst });
  });

  it('refuses a request without a token', async () => {
    const res = await get('');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_MISSING' });
  });

  it('refuses a token that is not a Bearer token', async () => {
    const res = await request(t.http)
      .get('/internal/v1/reports')
      .set('Authorization', `Basic ${await signToken({ act: analyst })}`);

    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_MISSING' });
  });

  it('refuses a bad signature, logging why for the operator but not telling the client', async () => {
    const res = await get(
      '',
      await signToken({ act: analyst, secret: 'some-other-secret-0123456789-abcdefgh' }),
    );

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({
      statusCode: 401,
      code: 'AUTH_TOKEN_INVALID',
      message: 'The access token is invalid.',
      requestId: res.headers['x-request-id'],
    });
    expect(
      capture.find((l) => l.requestId === res.headers['x-request-id'] && l.msg === 'token rejected'),
    ).toMatchObject({
      reason: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
      issuer: 'helium-admin',
    });
  });

  it('refuses an expired token', async () => {
    const res = await get(
      '',
      await signToken({ act: analyst, issuedAt: now() - 600, expiresAt: now() - 300 }),
    );

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
  });

  it('refuses a token older than 5 minutes even if its exp is later', async () => {
    const res = await get(
      '',
      await signToken({ act: analyst, issuedAt: now() - 600, expiresAt: now() + 3600 }),
    );

    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
  });

  it.each([
    ['a wrong audience', { audience: 'someone-else' }],
    ['an unknown caller', { issuer: 'stranger' }],
    ['a malformed act claim', { act: { id: 'u1', roles: 'analyst' } }],
  ])('refuses %s', async (_case, options) => {
    const res = await get('', await signToken({ act: analyst, ...options }));

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
  });

  it('refuses garbage and unsigned tokens', async () => {
    const unsigned = [
      Buffer.from('{"alg":"none"}').toString('base64url'),
      Buffer.from(
        JSON.stringify({ iss: 'helium-admin', aud: 'helium-backend', iat: now(), exp: now() + 60 }),
      ).toString('base64url'),
      '',
    ].join('.');

    for (const token of ['not-a-jwt', unsigned]) {
      expect((await get('', token)).body).toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
    }
  });

  it('refuses a user without the permission, naming what is required', async () => {
    const res = await get('', await signToken({ act: { ...analyst, roles: ['viewer'] } }));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED', details: { required: ['reports:read'] } });
  });

  it('refuses a service-only token (no user) on a route that needs a permission', async () => {
    const res = await get('', await signToken());

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('serves a public route without a token', async () => {
    expect((await get('/open')).status).toBe(200);
  });

  it('refuses a route that declares no access, even with a valid token', async () => {
    const res = await get('/undeclared', await signToken({ act: analyst }));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'ACCESS_NOT_DECLARED' });
  });
});
