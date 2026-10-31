import type { AddressInfo } from 'node:net';
import { getConnectionToken } from '@nestjs/mongoose';
import { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infrastructure/database/index.js';
import { messagingKeys } from '../src/modules/messaging/index.js';
import { WorkerModule } from '../src/worker.module.js';
import { DEFAULT_TEMPLATES } from '../tools/mock-meta/fixtures.ts';
import { startMockMeta, type MockMeta } from '../tools/mock-meta/mock-meta.ts';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { applyMigrations } from './helpers/migrations.js';
import { isolatedDatabases } from './helpers/mongo.js';
import { isolatedRedis } from './helpers/redis.js';
import { isolatedQueues, testSqsClient } from './helpers/sqs.js';
import { signToken } from './helpers/tokens.js';

const APP_SECRET = 'test-app-secret-0123456789';

async function eventually<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

describe('inbox, direct messages and suppressions (API, worker, mock-meta)', () => {
  const original = { ...process.env };
  let api: TestApp;
  let worker: TestApp;
  let meta: MockMeta;
  let db: Connection;
  let redis: Redis;
  let support: string;

  beforeAll(async () => {
    isolatedDatabases('inbox');
    isolatedRedis(9);
    const sqs = testSqsClient();
    await isolatedQueues(sqs, 'inbox-', [
      'wa-send-p1',
      'wa-send-p2',
      'wa-status',
      'wa-inbound',
      'wa-account',
    ]);
    sqs.destroy();
    api = await createTestApp();
    await api.app.listen(0);
    const { port } = api.http.address() as AddressInfo;
    meta = await startMockMeta({
      port: 0,
      webhookUrl: `http://127.0.0.1:${String(port)}/webhooks/whatsapp`,
      appSecret: APP_SECRET,
      latencyMs: { p50: 2, p99: 5 },
    });
    process.env['WA_GRAPH_URL'] = meta.url;
    process.env['WORKER_QUEUES'] = 'wa-inbound,wa-send-p1,wa-status';
    worker = await createTestApp({ module: WorkerModule });
    db = api.app.get<Connection>(getConnectionToken(DB.messaging));
    await applyMigrations(db);
    redis = api.app.get(Redis);
    support = await signToken({ act: { id: 's1', email: 'support@heliumair.in', roles: ['support'] } });
    await db.collection('templates').insertMany(
      DEFAULT_TEMPLATES.map((t) => ({
        _id: t.id as never,
        accountId: 'main',
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        quality: t.quality_score.score,
        components: t.components,
        syncedAt: new Date(),
      })),
    );
    await api.app
      .get<Connection>(getConnectionToken(DB.main))
      .collection('users')
      .insertOne({
        phone: '9840000111',
        name: 'Meera Iyer',
        email: 'meera@x.in',
        address: { city: 'Chennai' },
      });
  });

  afterAll(async () => {
    await meta.close();
    await worker.app.close();
    await api.app.close();
    process.env = { ...original };
  });

  const call = (method: 'get' | 'post' | 'put' | 'delete', path: string, auth = support) =>
    request(api.http)[method](`/internal/v1${path}`).set('Authorization', `Bearer ${auth}`);

  it('shows a customer message in the inbox, lets support reply inside the window, and marks it read', async () => {
    await fetch(`${meta.url}/_sim/inbound`, {
      method: 'POST',
      body: JSON.stringify({ from: '919840000111', text: 'Is the filter in stock?', name: 'Meera' }),
    });
    const conversation = await eventually(async () => {
      const list = (await call('get', '/conversations?unread=true')).body as {
        items: { phone: string; unread: number; lastPreview: string }[];
      };
      return list.items.find((c) => c.phone === '919840000111');
    });
    expect(conversation).toMatchObject({ unread: 1, lastPreview: 'Is the filter in stock?' });

    const contact = await call('get', '/contacts/9840000111');
    expect(contact.body).toMatchObject({
      phone: '919840000111',
      profile: { name: 'Meera Iyer', email: 'meera@x.in', city: 'Chennai' },
      unread: 1,
      suppressed: null,
    });
    expect((contact.body as { serviceWindowOpenUntil: string | null }).serviceWindowOpenUntil).not.toBeNull();

    const reply = await call('post', '/contacts/919840000111/messages').send({
      text: 'Yes, it ships today.',
    });
    expect(reply.status).toBe(202);
    await eventually(() =>
      Promise.resolve(meta.sent.some((m) => m.to === '919840000111' && m.type === 'text')),
    );
    const timeline = (await call('get', '/contacts/919840000111')).body as {
      timeline: { direction: string; text: string }[];
    };
    expect(timeline.timeline.map((t) => [t.direction, t.text])).toEqual([
      ['outbound', 'Yes, it ships today.'],
      ['inbound', 'Is the filter in stock?'],
    ]);

    expect((await call('post', '/contacts/919840000111/read')).status).toBe(204);
    expect(((await call('get', '/contacts/919840000111')).body as { unread: number }).unread).toBe(0);
  });

  it("refuses free text to someone who hasn't written in 24 hours, and sends an approved template instead", async () => {
    const text = await call('post', '/contacts/919840000222/messages').send({ text: 'Hello?' });
    expect(text.status).toBe(422);
    expect(text.body).toMatchObject({ code: 'SERVICE_WINDOW_CLOSED' });

    const template = await call('post', '/contacts/919840000222/messages').send({
      template: { templateId: '900000000000003', header: ['Ravi'], body: ['1 May'] },
    });
    expect(template.status).toBe(202);
    await eventually(() =>
      Promise.resolve(meta.sent.some((m) => m.to === '919840000222' && m.template === 'service_reminder')),
    );

    const paused = await call('post', '/contacts/919840000222/messages').send({
      template: { templateId: '900000000000005' },
    });
    expect(paused.body).toMatchObject({ code: 'TEMPLATE_NOT_APPROVED' });
  });

  it('searches customers by name', async () => {
    const res = await call('get', '/contacts?q=meera');

    expect(res.body).toEqual({
      items: [expect.objectContaining({ phone: '919840000111', name: 'Meera Iyer' })],
    });
  });

  it('adds, lists, imports and removes suppressions, keeping the Redis mirror in step', async () => {
    expect((await call('put', '/suppressions/9840000333')).body).toEqual({
      phone: '919840000333',
      added: true,
    });
    expect(await redis.sismember(messagingKeys.suppressed(), '919840000333')).toBe(1);
    expect(
      ((await call('get', '/contacts/919840000333')).body as { suppressed: unknown }).suppressed,
    ).toMatchObject({ reason: 'admin' });

    const imported = await call('post', '/suppressions/import').attach(
      'file',
      Buffer.from('phone\n9840000444\n9840000333\nnot-a-phone\n'),
      { filename: 's.csv' },
    );
    expect(imported.body).toEqual({ added: 1, invalid: ['not-a-phone'] });

    const list = (await call('get', '/suppressions')).body as { items: { phone: string; reason: string }[] };
    expect(list.items.map((s) => [s.phone, s.reason])).toEqual([
      ['919840000333', 'admin'],
      ['919840000444', 'import'],
    ]);

    expect((await call('delete', '/suppressions/919840000333')).body).toEqual({
      phone: '919840000333',
      removed: true,
    });
    expect(await redis.sismember(messagingKeys.suppressed(), '919840000333')).toBe(0);
  });

  it('allows viewers to read the inbox but not to send', async () => {
    const viewer = await signToken({ act: { id: 'v1', email: 'v@heliumair.in', roles: ['viewer'] } });

    expect((await call('get', '/conversations', viewer)).status).toBe(200);
    expect((await call('post', '/contacts/919840000111/messages', viewer).send({ text: 'x' })).status).toBe(
      403,
    );
    expect((await call('get', '/contacts/12345', viewer)).status).toBe(400);
  });
});
