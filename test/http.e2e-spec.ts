import type { IncomingMessage } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Body, Get, Module, Post, type RawBodyRequest, Req } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { InternalController } from '../src/common/http/index.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { LogCapture } from './helpers/log-capture.js';

const anyObject = z.looseObject({});

/** Test-only routes for the HTTP layer. */
@InternalController('things')
class ThingsController {
  @Get()
  list(): { items: never[] } {
    return { items: [] };
  }

  @Post('echo')
  echo(@Body({ schema: anyObject }) body: z.infer<typeof anyObject>): unknown {
    return body;
  }

  @Post('raw')
  raw(@Req() req: RawBodyRequest<IncomingMessage>): { raw: string | undefined } {
    return { raw: req.rawBody?.toString('utf8') };
  }

  @Get('slow')
  async slow(): Promise<{ done: true }> {
    await sleep(300);
    return { done: true };
  }
}

@Module({ imports: [AppModule], controllers: [ThingsController] })
class ThingsModule {}

describe('HTTP layer', () => {
  const capture = new LogCapture();
  let t: TestApp;

  beforeAll(async () => {
    process.env['LOG_LEVEL'] = 'info';
    t = await createTestApp({ module: ThingsModule, override: capture.override });
  });

  afterAll(async () => {
    await t.app.close();
    process.env['LOG_LEVEL'] = 'silent';
  });

  it('serves internal controllers under /internal/v1 only', async () => {
    expect((await request(t.http).get('/internal/v1/things')).status).toBe(200);
    expect((await request(t.http).get('/things')).status).toBe(404);
  });

  it('accepts a JSON body up to the limit', async () => {
    const res = await request(t.http)
      .post('/internal/v1/things/echo')
      .send({ text: 'a'.repeat(900_000) });

    expect(res.status).toBe(201);
  });

  it('rejects a body over the limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(t.http)
      .post('/internal/v1/things/echo')
      .send({ text: 'a'.repeat(1_100_000) });

    expect(res.status).toBe(413);
    expect(res.body).toStrictEqual({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'The request body is too large.',
      requestId: res.headers['x-request-id'],
    });
  });

  it('logs a body rejected before routing once, as "request rejected"', async () => {
    const res = await request(t.http)
      .post('/internal/v1/things/echo')
      .send({ text: 'a'.repeat(1_100_000) });
    const lines = capture.lines.filter((l) => l.requestId === res.headers['x-request-id']);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      msg: 'request rejected',
      req: { method: 'POST', path: '/internal/v1/things/echo' },
      res: { statusCode: 413 },
    });
    expect(lines[0]?.['req']).toEqual({ method: 'POST', path: '/internal/v1/things/echo' });
  });

  it('parses JSON only', async () => {
    const res = await request(t.http).post('/internal/v1/things/echo').type('form').send('a=1');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('keeps the exact bytes of a JSON body for signature checks', async () => {
    const payload = '{"b": 2,   "a":1}';
    const res = await request(t.http)
      .post('/internal/v1/things/raw')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.body).toEqual({ raw: payload });
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(t.http).get('/internal/v1/things');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows no browser origins by default', async () => {
    const res = await request(t.http).get('/internal/v1/things').set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CORS from config', () => {
  const original = { ...process.env };
  let t: TestApp;

  beforeAll(async () => {
    process.env['CORS_ORIGINS'] = 'https://admin.heliumair.in';
    t = await createTestApp({ module: ThingsModule });
  });

  afterAll(async () => {
    await t.app.close();
    process.env = { ...original };
  });

  it('allows only the configured origins', async () => {
    const allowed = await request(t.http)
      .options('/internal/v1/things')
      .set('Origin', 'https://admin.heliumair.in')
      .set('Access-Control-Request-Method', 'GET');
    const other = await request(t.http).get('/internal/v1/things').set('Origin', 'https://evil.example');

    expect(allowed.headers['access-control-allow-origin']).toBe('https://admin.heliumair.in');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('graceful shutdown', () => {
  it('lets an in-flight request finish when the app closes', async () => {
    const t = await createTestApp({ module: ThingsModule });
    await new Promise<void>((resolve) => t.http.listen(0, resolve));

    const inFlight = request(t.http).get('/internal/v1/things/slow');
    const response = inFlight.then((res) => res);
    await sleep(100);
    await t.app.close();

    const res = await response;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: true });
    expect(t.http.listening).toBe(false);
  });
});
