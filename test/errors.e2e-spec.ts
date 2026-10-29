import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { NotFoundError, RateLimitedError, ValidationError } from '../src/common/errors/index.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { LogCapture, type LogLine } from './helpers/log-capture.js';
import { Public } from '../src/common/auth/index.js';

class ThingNotFoundError extends NotFoundError {
  constructor(thingId: string) {
    super('THING_NOT_FOUND', 'Thing not found.', { details: { thingId } });
  }
}

/** Test-only routes that fail in each way the error contract covers. */
@Public()
@Controller('fail')
class FailController {
  @Get('domain')
  domain(): never {
    throw new ThingNotFoundError('t1');
  }

  @Get('unknown')
  unknown(): never {
    throw new Error('db.internal refused password=hunter2');
  }

  @Get('validation')
  validation(): never {
    throw new ValidationError({ 'body.name': 'Required' });
  }

  @Get('rate-limited')
  rateLimited(): never {
    throw new RateLimitedError(30);
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

@Module({ imports: [AppModule], controllers: [FailController] })
class FailModule {}

describe('error responses', () => {
  const capture = new LogCapture();
  let t: TestApp;

  beforeAll(async () => {
    process.env['LOG_LEVEL'] = 'info';
    t = await createTestApp({ module: FailModule, override: capture.override });
  });

  afterAll(async () => {
    await t.app.close();
    process.env['LOG_LEVEL'] = 'silent';
  });

  const linesFor = async (requestId: string): Promise<LogLine[]> => {
    await vi.waitFor(() => {
      if (!capture.find((l) => l.requestId === requestId && l.msg?.startsWith('request ') === true)) {
        throw new Error(`no access log line for ${requestId}`);
      }
    });
    return capture.lines.filter((l) => l.requestId === requestId);
  };

  it('returns a domain error with its code, message and details', async () => {
    const res = await request(t.http).get('/fail/domain');

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({
      statusCode: 404,
      code: 'THING_NOT_FOUND',
      message: 'Thing not found.',
      details: { thingId: 't1' },
      requestId: res.headers['x-request-id'],
    });

    const lines = await linesFor(res.headers['x-request-id'] as string);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', res: { statusCode: 404 } });
  });

  it('hides an unknown error from the client and logs it once, with its stack', async () => {
    const res = await request(t.http).get('/fail/unknown');

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Try again later.',
      requestId: res.headers['x-request-id'],
    });
    expect(res.text).not.toContain('hunter2');

    const lines = await linesFor(res.headers['x-request-id'] as string);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      msg: 'request failed',
      res: { statusCode: 500 },
      err: { type: 'Error', message: 'db.internal refused password=hunter2' },
    });
    expect(lines[0]?.['err']).toHaveProperty('stack');
  });

  it("maps Nest's own 404 for an unknown route", async () => {
    const res = await request(t.http).get('/no-such-route');

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      requestId: res.headers['x-request-id'],
    });
  });

  it('maps a body that is not valid JSON to 400 BAD_REQUEST', async () => {
    const res = await request(t.http)
      .post('/fail/echo')
      .set('Content-Type', 'application/json')
      .send('{"a":');

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'The request is invalid.',
      requestId: res.headers['x-request-id'],
    });
  });

  it('returns the validation shape with per-field details', async () => {
    const res = await request(t.http).get('/fail/validation');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      details: { fields: { 'body.name': 'Required' } },
    });
  });

  it('returns the rate-limit shape with the wait time', async () => {
    const res = await request(t.http).get('/fail/rate-limited');

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 30 },
    });
  });

  it("puts the caller's request ID in the error body", async () => {
    const res = await request(t.http).get('/fail/domain').set('X-Request-Id', 'caller-7');

    expect(res.headers['x-request-id']).toBe('caller-7');
    expect(res.body).toMatchObject({ requestId: 'caller-7' });
  });
});
