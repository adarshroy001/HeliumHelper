import type { AddressInfo } from 'node:net';
import { getConnectionToken } from '@nestjs/mongoose';
import { Redis } from 'ioredis';
import { type Connection, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueuePublisher } from '../src/infrastructure/queue/index.js';
import { DB } from '../src/infrastructure/database/index.js';
import { messagingJob } from '../src/modules/messaging/jobs/messaging-jobs.js';
import { keys } from '../src/modules/messaging/messaging.keys.js';
import { WorkerModule } from '../src/worker.module.js';
import { startMockMeta, type MockMeta } from '../tools/mock-meta/mock-meta.ts';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { applyMigrations } from './helpers/migrations.js';
import { isolatedDatabases } from './helpers/mongo.js';
import { isolatedRedis } from './helpers/redis.js';
import { isolatedQueues, testSqsClient } from './helpers/sqs.js';

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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('account events and template sync (API webhook, worker, mock-meta)', () => {
  const original = { ...process.env };
  let api: TestApp;
  let worker: TestApp;
  let meta: MockMeta;
  let db: Connection;
  let redis: Redis;

  beforeAll(async () => {
    isolatedDatabases('account');
    isolatedRedis(4);
    const sqs = testSqsClient();
    await isolatedQueues(sqs, 'account-', ['wa-status', 'wa-inbound', 'wa-account', 'messaging-jobs']);
    sqs.destroy();
    api = await createTestApp();
    await api.app.listen(0);
    const { port } = api.http.address() as AddressInfo;
    meta = await startMockMeta({
      port: 0,
      webhookUrl: `http://127.0.0.1:${String(port)}/webhooks/whatsapp`,
      appSecret: APP_SECRET,
    });
    process.env['WA_GRAPH_URL'] = meta.url;
    process.env['WORKER_QUEUES'] = 'wa-account,messaging-jobs';
    worker = await createTestApp({ module: WorkerModule });
    db = worker.app.get<Connection>(getConnectionToken(DB.messaging));
    await applyMigrations(db);
    redis = worker.app.get(Redis);
  });

  afterAll(async () => {
    await redis.del(keys.marketingPaused('main'), keys.accountPaused('main'));
    await meta.close();
    await worker.app.close();
    await api.app.close();
    process.env = { ...original };
  });

  const accountEvent = (field: string, value: Record<string, unknown>) =>
    fetch(`${meta.url}/_sim/account`, { method: 'POST', body: JSON.stringify({ field, value }) });
  const runJob = (job: 'templates-sync' | 'suppressions-reload') =>
    worker.app.get(QueuePublisher).publish('messaging-jobs', messagingJob, { job });
  const templates = () => db.collection('templates');

  it("syncs Meta's templates, and removes the ones Meta no longer has", async () => {
    await runJob('templates-sync');
    await eventually(async () => (await templates().countDocuments()) === 5);
    expect(await templates().findOne({ name: 'purifier_poll' })).toMatchObject({
      _id: '900000000000002',
      status: 'APPROVED',
      category: 'MARKETING',
      quality: 'GREEN',
      accountId: 'main',
    });
    expect(await db.collection('wa_accounts').findOne({ _id: 'main' as never })).toMatchObject({
      quality: 'GREEN',
    });

    await fetch(`${meta.url}/_sim/templates`, {
      method: 'PUT',
      body: JSON.stringify({
        templates: [
          {
            id: '900000000000004',
            name: 'thank_you',
            language: 'en',
            status: 'APPROVED',
            category: 'UTILITY',
            quality_score: { score: 'UNKNOWN' },
            components: [],
          },
        ],
      }),
    });
    await runJob('templates-sync');
    await eventually(async () => (await templates().countDocuments()) === 1);
    await fetch(`${meta.url}/_sim/templates`, { method: 'PUT', body: '{}' });
    await runJob('templates-sync');
    await eventually(async () => (await templates().countDocuments()) === 5);
  });

  it('pauses the sending campaigns that use a template Meta paused, and records the new status', async () => {
    const sending = String(new Types.ObjectId());
    const stopped = String(new Types.ObjectId());
    await redis.set(keys.campaignState(sending), 'sending');
    await redis.set(keys.campaignState(stopped), 'stopped');
    await redis.sadd(keys.templateCampaigns('purifier_poll', 'en'), sending, stopped);

    await accountEvent('message_template_status_update', {
      event: 'PAUSED',
      message_template_id: 900000000000002,
      message_template_name: 'purifier_poll',
      message_template_language: 'en',
      reason: 'LOW_QUALITY',
    });

    await eventually(async () => (await redis.get(keys.campaignState(sending))) === 'paused');
    expect(await redis.get(keys.campaignPauseRequest(sending))).toBe(
      'template purifier_poll paused by Meta: LOW_QUALITY',
    );
    expect(await redis.get(keys.campaignState(stopped))).toBe('stopped');
    expect(await templates().findOne({ _id: '900000000000002' as never })).toMatchObject({
      status: 'PAUSED',
    });
  });

  it('pauses marketing when the number is flagged, and allows it again when unflagged', async () => {
    await accountEvent('phone_number_quality_update', { event: 'FLAGGED', current_limit: 'TIER_1K' });
    await eventually(async () => (await redis.get(keys.marketingPaused('main'))) !== null);
    expect(await db.collection('wa_accounts').findOne({ _id: 'main' as never })).toMatchObject({
      quality: 'FLAGGED',
      messagingLimit: 'TIER_1K',
    });

    await accountEvent('phone_number_quality_update', { event: 'UNFLAGGED', current_limit: 'TIER_1K' });
    await eventually(async () => (await redis.get(keys.marketingPaused('main'))) === null);
  });

  it("records the portfolio's messaging limit", async () => {
    await accountEvent('business_capability_update', { max_daily_conversations_per_business: 10000 });
    await eventually(async () => (await redis.get(keys.messagingLimit('100000000000003'))) === '10000');
  });

  it('pauses the whole account when Meta restricts it', async () => {
    await accountEvent('account_update', { event: 'ACCOUNT_RESTRICTION' });

    await eventually(async () => (await redis.get(keys.accountPaused('main'))) !== null);
    expect(await db.collection('wa_accounts').findOne({ _id: 'main' as never })).toMatchObject({
      status: 'paused',
      pauseReason: 'account account_restriction',
    });
    await redis.del(keys.accountPaused('main'));
  });

  it('reloads the Redis mirror of the suppression list', async () => {
    await db
      .collection('suppressions')
      .insertOne({ _id: '919860000011' as never, reason: 'admin', createdAt: new Date() });

    await runJob('suppressions-reload');

    await eventually(async () => (await redis.sismember(keys.suppressed(), '919860000011')) === 1);
    await redis.srem(keys.suppressed(), '919860000011');
  });
});
