import { Controller, Get, Module } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { LogCapture } from './helpers/log-capture.js';

/** Test-only route: logs a structured line and returns the request context's ID. */
@Controller('probe')
class ProbeController {
  constructor(
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProbeController.name);
  }

  @Get()
  probe(): { contextId: string } {
    this.logger.info(
      { token: 'secret-token-value', nested: { password: 'hunter2' }, note: 'kept' },
      'probe ran',
    );
    return { contextId: this.cls.getId() };
  }
}

@Module({ imports: [AppModule], controllers: [ProbeController] })
class ProbeModule {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('logging and request context', () => {
  const capture = new LogCapture();
  let t: TestApp;

  beforeAll(async () => {
    process.env['LOG_LEVEL'] = 'info';
    t = await createTestApp({ module: ProbeModule, override: capture.override });
  });

  afterAll(async () => {
    await t.app.close();
    process.env['LOG_LEVEL'] = 'silent';
  });

  const accessLogFor = (requestId: string) =>
    vi.waitFor(() => {
      const line = capture.find((l) => l.msg === 'request completed' && l.requestId === requestId);
      if (!line) throw new Error(`no access log line for ${requestId}`);
      return line;
    });

  it('uses one generated ID for the response header, the request context and every log line', async () => {
    const res = await request(t.http).get('/probe');
    const id = res.headers['x-request-id'] as string;

    expect(id).toMatch(UUID);
    expect(res.body).toEqual({ contextId: id });

    const appLine = capture.find((l) => l.msg === 'probe ran');
    expect(appLine?.requestId).toBe(id);

    const access = await accessLogFor(id);
    expect(access).toMatchObject({
      level: 'info',
      service: 'helium-backend',
      env: 'local',
      req: { method: 'GET', path: '/probe' },
      res: { statusCode: 200 },
    });
    expect(typeof access['durationMs']).toBe('number');
  });

  it('reuses a safe X-Request-Id from the caller', async () => {
    const res = await request(t.http).get('/probe').set('X-Request-Id', 'caller-42');

    expect(res.headers['x-request-id']).toBe('caller-42');
    expect(res.body).toEqual({ contextId: 'caller-42' });
    await accessLogFor('caller-42');
  });

  it('replaces an unsafe X-Request-Id', async () => {
    const res = await request(t.http).get('/probe').set('X-Request-Id', 'bad id with spaces');

    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('redacts secrets in app logs but keeps other fields', () => {
    const line = capture.find((l) => l.msg === 'probe ran');

    expect(line).toMatchObject({ token: '[Redacted]', nested: { password: '[Redacted]' }, note: 'kept' });
    expect(capture.text).not.toContain('secret-token-value');
    expect(capture.text).not.toContain('hunter2');
  });

  it('logs neither request headers nor query strings', async () => {
    const res = await request(t.http)
      .get('/probe?phone=919876543210')
      .set('Authorization', 'Bearer top-secret-jwt')
      .set('Cookie', 'session=abc');
    const access = await accessLogFor(res.headers['x-request-id'] as string);

    expect(access['req']).toEqual({ method: 'GET', path: '/probe' });
    expect(capture.text).not.toContain('top-secret-jwt');
    expect(capture.text).not.toContain('session=abc');
    expect(capture.text).not.toContain('919876543210');
  });

  it('logs a 404 at warn level', async () => {
    const res = await request(t.http).get('/nope');
    const id = res.headers['x-request-id'] as string;

    const line = await vi.waitFor(() => {
      const found = capture.find((l) => l.requestId === id && l.msg === 'request completed');
      if (!found) throw new Error('missing');
      return found;
    });
    expect(line).toMatchObject({ level: 'warn', res: { statusCode: 404 } });
  });

  it('does not access-log health checks', async () => {
    const res = await request(t.http).get('/health/live');
    const id = res.headers['x-request-id'] as string;

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(capture.find((l) => l.requestId === id)).toBeUndefined();
  });
});
