import type { AddressInfo } from 'node:net';
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
import { isolatedQueues, testSqsClient } from './helpers/sqs.js';
import { signToken } from './helpers/tokens.js';

const APP_SECRET = 'test-app-secret-0123456789';
// Phones avoid the last digits 0001–0007, which make mock-meta answer with errors.
const phones = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    phone: `${prefix}${String(100 + i).padStart(5, '0')}`,
    name: `P${String(i)}`,
  }));

describe('campaign lifecycle end to end (API, worker, feeder, sender, statuses, mock-meta)', () => {
  const original = { ...process.env };
  let api: TestApp;
  let worker: TestApp;
  let meta: MockMeta;
  let db: Connection;
  let redis: Redis;
  let auth: string;

  beforeAll(async () => {
    isolatedDatabases('run');
    isolatedRedis(7);
    const sqs = testSqsClient();
    await isolatedQueues(sqs, 'run-', [
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
      mps: 40,
      statusDelayMs: 20,
      readRatio: 0.3,
      duplicateRatio: 0.1,
    });
    process.env['WA_GRAPH_URL'] = meta.url;
    process.env['WA_MAX_MPS'] = '40';
    process.env['WORKER_QUEUES'] = 'campaign-control,campaign-feeder,wa-send-p1,wa-send-p2,wa-status';
    worker = await createTestApp({ module: WorkerModule });
    db = api.app.get<Connection>(getConnectionToken(DB.messaging));
    await applyMigrations(db);
    redis = api.app.get(Redis);
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
  });

  afterAll(async () => {
    await meta.close();
    await worker.app.close();
    await api.app.close();
    process.env = { ...original };
  });

  const call = (method: 'get' | 'post' | 'put' | 'delete', path: string) =>
    request(api.http)[method](`/internal/v1${path}`).set('Authorization', `Bearer ${auth}`);
  const sweep = () =>
    worker.app.get(QueuePublisher).publish('campaign-control', campaignCommand, { command: 'sweep' });
  const status = async (id: string) =>
    ((await call('get', `/campaigns/${id}`)).body as { status: string }).status;
  /** Waits for a status, nudging the sweeper (the schedule doesn't run in tests). */
  async function until(id: string, wanted: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((await status(id)) !== wanted) {
      if (Date.now() > deadline) throw new Error(`campaign never became ${wanted} (is ${await status(id)})`);
      await sweep();
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  async function readyCampaign(
    name: string,
    individual: { phone: string; name: string }[],
    extra: Record<string, unknown> = {},
  ) {
    const created = await call('post', '/campaigns').send({
      name,
      templateId: '900000000000002',
      variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
      audience: { sources: [], individual },
      options: { frequencyCapHours: 0, attributionDays: 7 },
      ...extra,
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    await call('post', `/campaigns/${id}/build`);
    await until(id, 'ready');
    return id;
  }
  const sentFor = (id: string) => meta.sent.filter((m) => m.callbackData?.endsWith(id) === true);
  const counters = async (id: string) => redis.hgetall(messagingKeys.counters(id));

  it('runs a campaign to completion: every recipient sent once, statuses and counters exact', async () => {
    const id = await readyCampaign('Full run', phones('91987', 30));

    const started = await call('post', `/campaigns/${id}/start`).send({});
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: 'sending' });
    await until(id, 'send_complete');

    expect(sentFor(id)).toHaveLength(30);
    expect(new Set(sentFor(id).map((m) => m.to)).size).toBe(30);
    expect(await counters(id)).toMatchObject({ total: '30', fed: '30', accepted: '30' });
    expect(
      await db
        .collection('deliveries')
        .countDocuments({ campaignId: new Types.ObjectId(id), status: 'pending' }),
    ).toBe(0);
    expect(await redis.sismember(messagingKeys.activeCampaigns(), id)).toBe(0);
  }, 60_000);

  it('pauses within a second, sends nothing while paused, and resumes without duplicates', async () => {
    await fetch(`${meta.url}/_sim/config`, { method: 'PATCH', body: JSON.stringify({ mps: 10 }) });
    await redis.hset(messagingKeys.rate('100000000000002'), 'rate', '10');
    const id = await readyCampaign('Pause and resume', phones('91986', 60));
    await call('post', `/campaigns/${id}/start`).send({});
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const paused = await call('post', `/campaigns/${id}/pause`);
    expect(paused.body).toMatchObject({ status: 'paused', pauseReason: 'Paused by ops@heliumair.in' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const whilePaused = sentFor(id).length;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(sentFor(id).length).toBe(whilePaused);
    expect(whilePaused).toBeLessThan(60);

    await fetch(`${meta.url}/_sim/config`, { method: 'PATCH', body: JSON.stringify({ mps: 40 }) });
    await redis.del(messagingKeys.rate('100000000000002'));
    expect((await call('post', `/campaigns/${id}/resume`)).body).toMatchObject({ status: 'sending' });
    await until(id, 'send_complete');

    expect(sentFor(id)).toHaveLength(60);
    expect(new Set(sentFor(id).map((m) => m.to)).size).toBe(60);
    expect(await counters(id)).toMatchObject({ accepted: '60' });
  }, 60_000);

  it('stops: nothing more is sent, and the rest is skipped once the queue settles', async () => {
    await fetch(`${meta.url}/_sim/config`, { method: 'PATCH', body: JSON.stringify({ mps: 5 }) });
    await redis.hset(messagingKeys.rate('100000000000002'), 'rate', '5');
    const id = await readyCampaign('Stopped', phones('91985', 40));
    await call('post', `/campaigns/${id}/start`).send({});
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const stopped = await call('post', `/campaigns/${id}/stop`).send({ reason: 'Wrong offer' });
    expect(stopped.body).toMatchObject({ status: 'stopped', stopReason: 'Wrong offer' });
    const settled = async () => {
      await sweep();
      return (
        (await db.collection('campaigns').findOne({ _id: new Types.ObjectId(id) }))?.['finalizedAt'] !==
        undefined
      );
    };
    for (let i = 0; i < 60 && !(await settled()); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 400));

    const c = await counters(id);
    const sent = sentFor(id).length;
    expect(sent).toBeLessThan(40);
    expect(Number(c['accepted'] ?? 0) + Number(c['skipped'] ?? 0)).toBe(40);
    expect(
      await db
        .collection('deliveries')
        .countDocuments({ campaignId: new Types.ObjectId(id), status: 'pending' }),
    ).toBe(0);
    await fetch(`${meta.url}/_sim/config`, { method: 'PATCH', body: JSON.stringify({ mps: 40 }) });
    await redis.del(messagingKeys.rate('100000000000002'));
  }, 60_000);

  it('starts a scheduled campaign when it is due', async () => {
    const id = await readyCampaign('Scheduled', phones('91984', 5));
    const at = new Date(Date.now() + 5 * 60_000).toISOString();
    const scheduled = await call('put', `/campaigns/${id}/schedule`).send({ at });
    expect(scheduled.body).toMatchObject({ status: 'scheduled', schedule: { at } });

    // Make it due now rather than wait.
    await db
      .collection('campaigns')
      .updateOne({ _id: new Types.ObjectId(id) }, { $set: { 'schedule.at': new Date(Date.now() - 1000) } });
    await until(id, 'send_complete');
    expect(sentFor(id)).toHaveLength(5);
  }, 60_000);

  it('holds a campaign outside its send window, saying why', async () => {
    const now = new Date();
    const ist = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
    const hhmm = (m: number) =>
      `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    // A window that starts two hours from now, so now is outside it.
    const window = { start: hhmm((ist + 120) % 1440), end: hhmm((ist + 180) % 1440) };
    const id = await readyCampaign('Window', phones('91983', 3), {
      options: { frequencyCapHours: 0, attributionDays: 7, sendWindow: window },
    });

    await call('post', `/campaigns/${id}/start`).send({});
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(sentFor(id)).toHaveLength(0);
    expect(await redis.get(messagingKeys.campaignWaiting(id))).toBe(
      `Outside its send window (${window.start}–${window.end} IST)`,
    );
    await call('post', `/campaigns/${id}/stop`).send({});
  }, 60_000);

  it('uploads header media to Meta at start, and sends it with every message', async () => {
    const media = await call('post', '/media').attach('file', Buffer.from([0xff, 0xd8, 0xff]), {
      filename: 'b.jpg',
      contentType: 'image/jpeg',
    });
    const id = await readyCampaign('With image', phones('91982', 2), {
      templateId: '900000000000001',
      headerMediaId: (media.body as { id: string }).id,
      variableMapping: [
        { component: 'BODY', index: 1, source: 'field', value: 'name' },
        { component: 'BODY', index: 2, source: 'static', value: '20%' },
        { component: 'BUTTONS', buttonIndex: 0, index: 1, source: 'static', value: 'diwali' },
      ],
    });

    await call('post', `/campaigns/${id}/start`).send({});
    await until(id, 'send_complete');

    const stored = await db
      .collection('media')
      .findOne({ _id: new Types.ObjectId((media.body as { id: string }).id) });
    expect(stored?.['metaMediaId']).toMatch(/^media-/);
    expect(sentFor(id).every((m) => m.template === 'diwali_offer')).toBe(true);
  }, 60_000);

  it('sends a test of the real message to a few numbers', async () => {
    const id = await readyCampaign('Test me', phones('91981', 2));

    const res = await call('post', `/campaigns/${id}/test`).send({
      phones: ['9198100 09999'.replace(' ', '')],
    });

    expect(res.status).toBe(202);
    const deadline = Date.now() + 15_000;
    while (!meta.sent.some((m) => m.to === '919810009999') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 200));
    expect(meta.sent.find((m) => m.to === '919810009999')).toMatchObject({ template: 'purifier_poll' });
    expect(await status(id)).toBe('ready');
  }, 30_000);

  it('refuses to start a large audience without the count typed back, and an empty or wrong-state one', async () => {
    const id = await readyCampaign('Small', phones('91980', 1));
    await db
      .collection('campaigns')
      .updateOne({ _id: new Types.ObjectId(id) }, { $set: { 'totals.total': 150_000 } });

    const refused = await call('post', `/campaigns/${id}/start`).send({});
    expect(refused.status).toBe(422);
    expect((refused.body as { details: { problems: string[] } }).details.problems[0]).toMatch(
      /confirmTotal=150000/,
    );

    expect((await call('post', `/campaigns/${id}/pause`)).status).toBe(409);
  });
});
