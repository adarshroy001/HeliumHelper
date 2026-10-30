import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Body, Module, Post } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { RequirePermissions, ROLE_PERMISSIONS } from '../src/common/auth/index.js';
import { ConflictError } from '../src/common/errors/index.js';
import { InternalController } from '../src/common/http/index.js';
import { Idempotent } from '../src/infrastructure/idempotency/index.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { signToken } from './helpers/tokens.js';

const order = z.strictObject({
  item: z.string(),
  fail: z.boolean().default(false),
  slowMs: z.number().default(0),
});

/** Test-only route that counts how often its handler really runs. */
@InternalController('orders')
@RequirePermissions('orders:write')
class OrdersController {
  runs = 0;

  @Post()
  @Idempotent()
  async create(@Body({ schema: order }) body: z.infer<typeof order>): Promise<{ run: number; item: string }> {
    this.runs += 1;
    await sleep(body.slowMs);
    if (body.fail) throw new ConflictError('OUT_OF_STOCK', 'Out of stock.');
    return { run: this.runs, item: body.item };
  }
}

@Module({ imports: [AppModule], controllers: [OrdersController] })
class OrdersModule {}

describe('idempotency', () => {
  let t: TestApp;
  let token: string;
  let otherCaller: string;

  beforeAll(async () => {
    process.env['AUTH_CALLER_SECRETS'] = JSON.stringify({
      'helium-admin': 'test-secret-0123456789-0123456789-abc',
      'ops-bot': 'ops-bot-secret-0123456789-0123456789',
    });
    t = await createTestApp({
      module: OrdersModule,
      override: (b) => b.overrideProvider(ROLE_PERMISSIONS).useValue({ clerk: ['orders:write'] }),
    });
    const act = { id: 'u1', email: 'asha@heliumair.in', roles: ['clerk'] };
    token = await signToken({ act });
    otherCaller = await signToken({ issuer: 'ops-bot', secret: 'ops-bot-secret-0123456789-0123456789', act });
  });

  afterAll(async () => {
    await t.app.close();
  });

  const post = (body: object, key?: string, auth = token) => {
    const req = request(t.http).post('/internal/v1/orders').set('Authorization', `Bearer ${auth}`).send(body);
    return key === undefined ? req : req.set('Idempotency-Key', key);
  };

  it('runs the handler every time without a key', async () => {
    const first = await post({ item: 'fan' });
    const second = await post({ item: 'fan' });

    expect((second.body as { run: number }).run).toBe((first.body as { run: number }).run + 1);
  });

  it('replays the first response for a retry with the same key and body', async () => {
    const key = randomUUID();
    const first = await post({ item: 'fan' }, key);
    const retry = await post({ item: 'fan' }, key);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
  });

  it('refuses the same key with a different body (422)', async () => {
    const key = randomUUID();
    await post({ item: 'fan' }, key);

    const res = await post({ item: 'heater' }, key);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('refuses a retry while the first request is still running (409)', async () => {
    const key = randomUUID();
    const slow = post({ item: 'fan', slowMs: 400 }, key).then((res) => res);
    await sleep(100);

    const retry = await post({ item: 'fan', slowMs: 400 }, key);

    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    expect((await slow).status).toBe(201);
  });

  it('keeps nothing for a failed request, so it can be retried', async () => {
    const key = randomUUID();
    const runsBefore = t.app.get(OrdersController).runs;

    expect((await post({ item: 'fan', fail: true }, key)).status).toBe(409);
    expect((await post({ item: 'fan', fail: true }, key)).body).toMatchObject({ code: 'OUT_OF_STOCK' });
    expect(t.app.get(OrdersController).runs).toBe(runsBefore + 2);
  });

  it('scopes keys to the calling service', async () => {
    const key = randomUUID();
    const mine = await post({ item: 'fan' }, key);
    const theirs = await post({ item: 'fan' }, key, otherCaller);

    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    expect((theirs.body as { run: number }).run).not.toBe((mine.body as { run: number }).run);
  });

  it('rejects a malformed key', async () => {
    const res = await post({ item: 'fan' }, 'has spaces in it');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { 'Idempotency-Key': expect.any(String) as unknown } },
    });
  });
});
