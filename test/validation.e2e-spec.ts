import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { paginationQuery, queryBoolean } from '../src/common/validation/index.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';

const createThing = z.strictObject({
  name: z.string().min(1).max(50),
  tags: z.array(z.string()).max(5).default([]),
});

const listThings = paginationQuery.extend({ archived: queryBoolean().optional() });

/** Test-only routes with the three kinds of validated input. */
@Controller('things')
class ThingsController {
  @Post()
  create(@Body({ schema: createThing }) body: z.infer<typeof createThing>): unknown {
    return body;
  }

  @Get()
  list(@Query({ schema: listThings }) query: z.infer<typeof listThings>): unknown {
    return query;
  }

  @Get(':id')
  get(@Param('id', { schema: z.uuid() }) id: string): unknown {
    return { id };
  }
}

@Module({ imports: [AppModule], controllers: [ThingsController] })
class ThingsModule {}

describe('request validation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ module: ThingsModule });
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('passes the parsed body, with defaults applied, to the handler', async () => {
    const res = await request(t.http).post('/things').send({ name: 'Fan' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'Fan', tags: [] });
  });

  it('rejects an unknown key with per-field details', async () => {
    const res = await request(t.http).post('/things').send({ name: 'Fan', colour: 'red' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: 'The request is invalid.',
      details: { fields: { colour: 'Unknown field.' } },
      requestId: res.headers['x-request-id'],
    });
  });

  it('rejects a wrong type, naming the field', async () => {
    const res = await request(t.http)
      .post('/things')
      .send({ name: 42, tags: ['a', 7] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        fields: {
          name: 'Invalid input: expected string, received number',
          'tags.1': 'Invalid input: expected string, received number',
        },
      },
    });
  });

  it('rejects a missing body', async () => {
    const res = await request(t.http).post('/things');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { '(root)': expect.any(String) as unknown } },
    });
  });

  it('coerces query values to typed ones', async () => {
    const res = await request(t.http).get('/things?limit=5&archived=false&cursor=abc');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ limit: 5, archived: false, cursor: 'abc' });
  });

  it('applies query defaults and rejects bad or unknown query values', async () => {
    expect((await request(t.http).get('/things')).body).toEqual({ limit: 20 });

    const res = await request(t.http).get('/things?limit=abc&archived=yes&page=2');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      details: {
        fields: {
          limit: 'Must be a whole number.',
          archived: 'Must be true or false.',
          page: 'Unknown field.',
        },
      },
    });
  });

  it('validates a single path parameter under its own name', async () => {
    const id = '0b8a6a3e-3f4b-4c1d-9a63-2f1e7b9b8c11';

    expect((await request(t.http).get(`/things/${id}`)).body).toEqual({ id });

    const res = await request(t.http).get('/things/not-a-uuid');
    expect(res.status).toBe(400);
    const { details } = res.body as { details: { fields: Record<string, string> } };
    expect(Object.keys(details.fields)).toEqual(['id']);
  });
});

describe('API docs', () => {
  const original = { ...process.env };

  afterAll(() => {
    process.env = { ...original };
  });

  it('serves the UI and an OpenAPI document built from the zod schemas outside production', async () => {
    const t = await createTestApp({ module: ThingsModule });

    const ui = await request(t.http).get('/docs');
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');

    const doc = await request(t.http).get('/docs-json');
    const body = doc.body as { paths: Record<string, Record<string, { requestBody?: unknown }>> };
    expect(body.paths['/things']?.['post']?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { name: { type: 'string', minLength: 1, maxLength: 50 } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
    });

    await t.app.close();
  });

  it('serves no docs in production', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', APP_ENV: 'production', LOG_LEVEL: 'info' });
    const t = await createTestApp({ module: ThingsModule });

    expect((await request(t.http).get('/docs')).status).toBe(404);
    expect((await request(t.http).get('/docs-json')).status).toBe(404);

    await t.app.close();
  });
});
