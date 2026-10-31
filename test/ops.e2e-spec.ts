import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { getConnectionToken } from '@nestjs/mongoose';
import { Redis } from 'ioredis';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infrastructure/database/index.js';
import { QueuePublisher } from '../src/infrastructure/queue/index.js';
import { campaignCommand } from '../src/modules/campaigns/control/campaign-control.js';
import { messagingKeys } from '../src/modules/messaging/index.js';
import { WorkerModule } from '../src/worker.module.js';
import { DEFAULT_TEMPLATES } from '../tools/mock-meta/fixtures.ts';
import { startMockMeta, type MockMeta } from '../tools/mock-meta/mock-meta.ts';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { applyMigrations } from './helpers/migrations.js';
import { isolatedDatabases } from './helpers/mongo.js';
import { isolatedRedis } from './helpers/redis.js';
import { isolatedQueues, receiveAll, testSqsClient } from './helpers/sqs.js';
import { signToken } from './helpers/tokens.js';

describe('messaging operations (API, worker, mock-meta)', () => {
  const original = { ...process.env };
  let api: TestApp;
  let worker: TestApp;
  let meta: MockMeta;
  let db: Connection;
  let redis: Redis;
  let ops: string;

  beforeAll(async () => {
    isolatedDatabases('ops');
    isolatedRedis(10);
    const sqs = testSqsClient();
    await isolatedQueues(sqs, 'ops-', [
      'wa-send-p1',
      'wa-send-p2',
      'wa-status',
      'wa-inbound',
      'wa-account',
      'messaging-jobs',
      'campaign-control',
    ]);
    sqs.destroy();
    meta = await startMockMeta({
      port: 0,
      appSecret: 'test-app-secret-0123456789',
      latencyMs: { p50: 2, p99: 5 },
    });
    process.env['WA_GRAPH_URL'] = meta.url;
    api = await createTestApp();
    process.env['WORKER_QUEUES'] = 'wa-send-p1,campaign-control';
    worker = await createTestApp({ module: WorkerModule });
    db = api.app.get<Connection>(getConnectionToken(DB.messaging));
    await applyMigrations(db);
    redis = api.app.get(Redis);
    ops = await signToken({ act: { id: 'o1', email: 'ops@heliumair.in', roles: ['admin'] } });
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
  });

  afterAll(async () => {
    await redis.del(messagingKeys.killSwitch());
    await meta.close();
    await worker.app.close();
    await api.app.close();
    process.env = { ...original };
  });

  const call = (method: 'get' | 'post' | 'put', path: string, auth = ops) =>
    request(api.http)[method](`/internal/v1${path}`).set('Authorization', `Bearer ${auth}`);

  it('shows queues, the account, the number and the kill switch', async () => {
    const res = await call('get', '/ops/messaging');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      killSwitch: false,
      account: { id: 'main', paused: false },
      number: { phoneNumberId: '100000000000002', maxMps: 80 },
    });
    expect(
      (res.body as { queues: { name: string; visible: number; dlq: { visible: number } }[] }).queues.map(
        (q) => q.name,
      ),
    ).toContain('wa-send-p2');
  });

  it('stops all sending with the kill switch, and lets queued messages through when it is lifted', async () => {
    expect((await call('put', '/ops/messaging/kill-switch').send({ on: true })).body).toEqual({
      killSwitch: true,
    });
    // Give the senders' gate a moment to see it.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await call('post', '/contacts/919890000111/messages', ops).send({
      template: { templateId: '900000000000004' },
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(meta.sent.filter((m) => m.to === '919890000111')).toHaveLength(0);

    await call('put', '/ops/messaging/kill-switch').send({ on: false });
    const deadline = Date.now() + 20_000;
    while (!meta.sent.some((m) => m.to === '919890000111') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 200));
    expect(meta.sent.filter((m) => m.to === '919890000111')).toHaveLength(1);
    expect(await db.collection('audit_log').findOne({ action: 'messaging.stop_all' })).not.toBeNull();
  }, 40_000);

  it("moves a DLQ's messages back to its queue", async () => {
    const sqs = testSqsClient();
    const prefix = process.env['SQS_QUEUE_URL_PREFIX'] ?? '';
    for (let i = 0; i < 3; i += 1)
      await sqs.send(
        new SendMessageCommand({ QueueUrl: `${prefix}wa-status-dlq`, MessageBody: `{"n":${String(i)}}` }),
      );

    const res = await call('post', '/ops/queues/wa-status/redrive');

    expect(res.body).toEqual({ moved: 3 });
    expect(await receiveAll(sqs, `${prefix}wa-status`)).toHaveLength(3);
    expect((await call('post', '/ops/queues/not-a-queue/redrive')).status).toBe(404);
    sqs.destroy();
  });

  it('resumes a paused account', async () => {
    await redis.set(messagingKeys.accountPaused('main'), 'token expired');
    await db
      .collection('wa_accounts')
      .updateOne({ _id: 'main' as never }, { $set: { status: 'paused', pauseReason: 'token expired' } });

    expect((await call('post', '/ops/accounts/main/resume')).status).toBe(204);
    expect(await redis.get(messagingKeys.accountPaused('main'))).toBeNull();
    expect(await db.collection('wa_accounts').findOne({ _id: 'main' as never })).toMatchObject({
      status: 'active',
    });
  });

  it("rebuilds a campaign's counters from the database after Redis lost them", async () => {
    const created = await call('post', '/campaigns').send({
      name: 'Reconcile me',
      templateId: '900000000000002',
      variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
      audience: {
        sources: [],
        individual: [1, 2, 3, 4].map((i) => ({ phone: `98950000${String(10 + i)}`, name: `P${String(i)}` })),
      },
      options: { frequencyCapHours: 0, attributionDays: 7 },
    });
    const id = (created.body as { id: string }).id;
    await call('post', `/campaigns/${id}/build`);
    const deadline = Date.now() + 15_000;
    while (
      ((await call('get', `/campaigns/${id}`)).body as { status: string }).status !== 'ready' &&
      Date.now() < deadline
    ) {
      await worker.app.get(QueuePublisher).publish('campaign-control', campaignCommand, { command: 'sweep' });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const campaign = new Types.ObjectId(id);
    const set = (to: string, fields: Record<string, unknown>) =>
      db.collection('deliveries').updateOne({ campaignId: campaign, to }, { $set: fields });
    await set('919895000011', {
      status: 'read',
      statusRank: 4,
      reply: { count: 1 },
      pricing: { billable: true, category: 'marketing' },
    });
    await set('919895000012', {
      status: 'delivered',
      statusRank: 3,
      pricing: { billable: true, category: 'marketing' },
    });
    await set('919895000013', { status: 'failed', statusRank: 9, providerMessageId: 'wamid.x' });

    const res = await call('post', `/ops/campaigns/${id}/reconcile`);

    expect(res.body).toEqual({
      counts: {
        total: 4,
        fed: 3,
        accepted: 3,
        sent: 2,
        delivered: 2,
        read: 1,
        failed: 1,
        skipped: 0,
        replied: 1,
        'billable:marketing': 2,
      },
    });
    expect(
      await redis.hget(
        messagingKeys.ranks(id),
        (await db.collection('deliveries').findOne({ campaignId: campaign, to: '919895000011' }))?.[
          '_id'
        ].toString() ?? '',
      ),
    ).toBe('4');
    expect(
      (
        await call(
          'post',
          `/ops/campaigns/${id}/reconcile`,
          await signToken({ act: { id: 'm', email: 'm@x.in', roles: ['marketing'] } }),
        )
      ).status,
    ).toBe(403);
  });
});
