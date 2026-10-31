import type { AddressInfo } from 'node:net';
import { getConnectionToken } from '@nestjs/mongoose';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infrastructure/database/index.js';
import { QueuePublisher } from '../src/infrastructure/queue/index.js';
import { campaignCommand } from '../src/modules/campaigns/control/campaign-control.js';
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
const PHONES = ['919790000111', '919790000112', '919790000113', '919790000114', '919790000115'];

describe('campaign reads: stats, recipients, replies, export, attribution', () => {
  const original = { ...process.env };
  let api: TestApp;
  let worker: TestApp;
  let meta: MockMeta;
  let db: Connection;
  let main: Connection;
  let auth: string;
  let id: string;

  const call = (method: 'get' | 'post', path: string) =>
    request(api.http)[method](`/internal/v1${path}`).set('Authorization', `Bearer ${auth}`);
  const sweep = () =>
    worker.app.get(QueuePublisher).publish('campaign-control', campaignCommand, { command: 'sweep' });
  async function until(check: () => Promise<boolean>, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await sweep();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  beforeAll(async () => {
    isolatedDatabases('reads');
    isolatedRedis(8);
    const sqs = testSqsClient();
    await isolatedQueues(sqs, 'reads-', [
      'campaign-control',
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
      statusDelayMs: 10,
      readRatio: 1,
      duplicateRatio: 0,
      skipDeliveredRatio: 0,
    });
    process.env['WA_GRAPH_URL'] = meta.url;
    process.env['WORKER_QUEUES'] =
      'campaign-control,campaign-feeder,wa-send-p1,wa-send-p2,wa-status,wa-inbound';
    worker = await createTestApp({ module: WorkerModule });
    db = api.app.get<Connection>(getConnectionToken(DB.messaging));
    main = api.app.get<Connection>(getConnectionToken(DB.main));
    await applyMigrations(db);
    auth = await signToken({ act: { id: 'a1', email: 'ops@heliumair.in', roles: ['admin'] } });
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

    // Run a small poll campaign to completion, with every message read.
    const created = await call('post', '/campaigns').send({
      name: 'Room poll',
      templateId: '900000000000002',
      variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
      audience: {
        sources: [],
        individual: PHONES.map((phone, i) => ({ phone, name: `Person ${String(i)}` })),
      },
      options: { frequencyCapHours: 0, attributionDays: 7 },
    });
    id = (created.body as { id: string }).id;
    await call('post', `/campaigns/${id}/build`);
    await until(
      async () => ((await call('get', `/campaigns/${id}`)).body as { status: string }).status === 'ready',
    );
    await call('post', `/campaigns/${id}/start`).send({});
    await until(
      async () =>
        ((await call('get', `/campaigns/${id}`)).body as { status: string }).status === 'send_complete',
    );
    await until(
      async () =>
        (await db
          .collection('deliveries')
          .countDocuments({ campaignId: new Types.ObjectId(id), status: 'read' })) === 5,
    );

    // Two people tap a poll button; one sends text.
    const wamidOf = async (to: string) =>
      (await db.collection('deliveries').findOne({ campaignId: new Types.ObjectId(id), to }))?.[
        'providerMessageId'
      ] as string;
    const reply = (body: Record<string, unknown>) =>
      fetch(`${meta.url}/_sim/inbound`, { method: 'POST', body: JSON.stringify(body) });
    await reply({
      from: PHONES[0],
      button: { text: 'Bedroom' },
      contextWamid: await wamidOf(PHONES[0] ?? ''),
    });
    await reply({
      from: PHONES[1],
      button: { text: 'Office' },
      contextWamid: await wamidOf(PHONES[1] ?? ''),
    });
    await reply({ from: PHONES[2], text: 'Price?', contextWamid: await wamidOf(PHONES[2] ?? '') });
    await until(
      async () => (await db.collection('inbound_messages').countDocuments({ campaignId: id })) === 3,
    );
  }, 90_000);

  afterAll(async () => {
    await meta.close();
    await worker.app.close();
    await api.app.close();
    process.env = { ...original };
  });

  it('reports live stats: counts, rates, cost and poll results', async () => {
    const res = await call('get', `/campaigns/${id}/stats`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'send_complete',
      counts: { total: 5, accepted: 5, sent: 5, delivered: 5, read: 5, replied: 3, failed: 0 },
      rates: { delivered: 1, read: 1, replied: 0.6 },
      etaSeconds: null,
      // Five marketing messages at the test price card (0.86 INR each).
      cost: { currency: 'INR', estimated: 4.3, actual: 4.3 },
    });
    expect((res.body as { buttons: unknown }).buttons).toEqual({
      total: 2,
      options: [
        { label: 'Bedroom', votes: 1, share: 0.5 },
        { label: 'Living room', votes: 0, share: 0 },
        { label: 'Office', votes: 1, share: 0.5 },
      ],
    });
  });

  it('pages the recipients table and filters it by reply and phone', async () => {
    const first = await call('get', `/campaigns/${id}/deliveries?limit=2`);
    const body = first.body as { items: { phone: string }[]; nextAfter: number };
    expect(body.items.map((d) => d.phone)).toEqual(PHONES.slice(0, 2));
    const second = await call('get', `/campaigns/${id}/deliveries?limit=2&after=${String(body.nextAfter)}`);
    expect((second.body as { items: { phone: string }[] }).items.map((d) => d.phone)).toEqual(
      PHONES.slice(2, 4),
    );

    const replied = await call('get', `/campaigns/${id}/deliveries?reply=any`);
    expect((replied.body as { items: unknown[] }).items).toHaveLength(3);
    const office = await call('get', `/campaigns/${id}/deliveries?reply=button:Office`);
    expect((office.body as { items: { phone: string }[] }).items.map((d) => d.phone)).toEqual([PHONES[1]]);
    const byPhone = await call('get', `/campaigns/${id}/deliveries?q=0115`);
    expect((byPhone.body as { items: { phone: string }[] }).items.map((d) => d.phone)).toEqual([PHONES[4]]);
  });

  it('lists replies, newest first', async () => {
    const res = await call('get', `/campaigns/${id}/replies`);

    expect((res.body as { items: { from: string }[] }).items.map((r) => r.from).sort()).toEqual(
      PHONES.slice(0, 3).sort(),
    );
  });

  it('exports every recipient as CSV, in the background, then serves the file', async () => {
    const requested = await call('post', `/campaigns/${id}/exports`);
    expect(requested.status).toBe(202);
    const exportId = (requested.body as { id: string }).id;
    await until(
      async () => ((await call('get', `/exports/${exportId}`)).body as { status: string }).status === 'done',
    );

    const file = await call('get', `/exports/${exportId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/^text\/csv/);
    expect(file.headers['content-disposition']).toBe(`attachment; filename="campaign-${id}.csv"`);
    const lines = file.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\n');
    expect(lines[0]).toBe(
      'phone,name,status,sent_at,delivered_at,read_at,failed_at,error_code,error,skip_reason,replies,first_reply_at,last_reply_at,last_button,pricing_category,wamid',
    );
    expect(lines).toHaveLength(6);
    expect(lines[1]).toMatch(/^919790000111,Person 0,read,/);
  });

  it('attributes orders placed by recipients after delivery', async () => {
    const now = new Date();
    await main.collection('orders').insertMany([
      { deliveryAddress: { phone: '9790000111' }, createdAt: now, status: 'delivered', sellingPrice: 24999 },
      {
        deliveryAddress: { phone: '+91 97900 00112' },
        createdAt: now,
        status: 'confirmed',
        payment: { amount: 19999 },
      },
      { deliveryAddress: { phone: '9790000113' }, createdAt: now, status: 'cancelled', sellingPrice: 9999 },
      { deliveryAddress: { phone: '9790009999' }, createdAt: now, status: 'delivered', sellingPrice: 5000 },
    ]);

    const res = await call('get', `/campaigns/${id}/attribution`);

    expect(res.body).toMatchObject({ attribution: { windowDays: 7, orders: 2, buyers: 2, revenue: 44998 } });
  });
});
