import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Redis } from 'ioredis';
import { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infrastructure/database/index.js';
import { QueuePublisher } from '../src/infrastructure/queue/index.js';
import { Delivery } from '../src/modules/messaging/data/delivery.schema.js';
import { keys } from '../src/modules/messaging/messaging.keys.js';
import { deliverySend, type DeliverySendData } from '../src/modules/messaging/messaging.messages.js';
import { GraphClient } from '../src/modules/messaging/index.js';
import { WorkerModule } from '../src/worker.module.js';
import { startMockMeta, type MockMeta } from '../tools/mock-meta/mock-meta.ts';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { applyMigrations } from './helpers/migrations.js';
import { isolatedDatabases } from './helpers/mongo.js';
import { isolatedQueues, testSqsClient } from './helpers/sqs.js';

// The app secret Vitest configures (vitest.config.ts); mock-meta signs with it.
const APP_SECRET = 'test-app-secret-0123456789';
const PHONE_NUMBER_ID = '100000000000002';

/** Waits until `check` returns something truthy, or fails after `timeoutMs`. */
async function eventually<T>(
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('sender (worker, MongoDB, Valkey, ElasticMQ, mock-meta)', () => {
  const original = { ...process.env };
  let meta: MockMeta;
  let t: TestApp;
  let deliveries: Model<Delivery>;
  let redis: Redis;
  let publisher: QueuePublisher;

  beforeAll(async () => {
    isolatedDatabases('sender');
    const sqs = testSqsClient();
    await isolatedQueues(sqs, 'sender-', ['wa-send-p1', 'wa-send-p2']);
    sqs.destroy();
    meta = await startMockMeta({
      port: 0,
      appSecret: APP_SECRET,
      latencyMs: { p50: 2, p99: 5 },
      mps: 1000,
      hangMs: 1500,
    });
    process.env['WA_GRAPH_URL'] = meta.url;
    process.env['WORKER_QUEUES'] = 'wa-send-p1,wa-send-p2';
    t = await createTestApp({
      module: WorkerModule,
      // A short timeout, so the "response hangs" case is quick.
      override: (b) =>
        b
          .overrideProvider(GraphClient)
          .useValue(
            new GraphClient({ baseUrl: meta.url, version: 'v26.0', accessToken: 'x', timeoutMs: 500 }),
          ),
    });
    await applyMigrations(t.app.get<Connection>(getConnectionToken(DB.messaging)));
    deliveries = t.app.get<Model<Delivery>>(getModelToken(Delivery.name, DB.messaging));
    redis = t.app.get(Redis);
    publisher = t.app.get(QueuePublisher);
  });

  afterAll(async () => {
    await t.app.close();
    await meta.close();
    process.env = { ...original };
  });

  /** A pending campaign delivery in the database, and its send message. */
  async function prepare(to: string, campaignId?: string): Promise<DeliverySendData> {
    const _id = new Types.ObjectId();
    const payload = {
      kind: 'template' as const,
      template: { name: 'diwali_offer', language: { code: 'en' } },
    };
    await deliveries.collection.insertOne({
      _id,
      source: { kind: campaignId === undefined ? 'direct' : 'campaign' },
      ...(campaignId === undefined
        ? {}
        : { campaignId: new Types.ObjectId(campaignId), dedupeKey: `${campaignId}:${to}` }),
      accountId: 'main',
      to,
      payload,
      status: 'pending',
      statusRank: 0,
      createdAt: new Date(),
    });
    return {
      deliveryId: String(_id),
      accountId: 'main',
      phoneNumberId: PHONE_NUMBER_ID,
      to,
      endpoint: 'marketing_messages',
      ...(campaignId === undefined ? {} : { campaignId }),
      payload,
      businessInitiated: true,
    };
  }

  async function sendingCampaign(state = 'sending'): Promise<string> {
    const campaignId = String(new Types.ObjectId());
    await redis.set(keys.campaignState(campaignId), state);
    return campaignId;
  }

  const delivery = (id: string) => deliveries.findById(new Types.ObjectId(id)).lean<Delivery>();
  const sentTo = (deliveryId: string) =>
    meta.sent.filter((m) => m.callbackData?.startsWith(`d:${deliveryId}`) === true).length;

  it('sends a campaign message once and records it as accepted, with its wamid and counters', async () => {
    const campaignId = await sendingCampaign();
    const message = await prepare('919810000001', campaignId);

    await publisher.publish('wa-send-p2', deliverySend, message, { groupId: campaignId });

    const stored = await eventually(async () => {
      const d = await delivery(message.deliveryId);
      return d?.status === 'accepted' ? d : undefined;
    });
    expect(stored.providerMessageId).toMatch(/^wamid\./);
    expect(sentTo(message.deliveryId)).toBe(1);
    expect(meta.sent.find((m) => m.callbackData === `d:${message.deliveryId}:${campaignId}`)?.endpoint).toBe(
      'marketing_messages',
    );
    expect(await redis.get(keys.wamid(stored.providerMessageId ?? ''))).toBe(
      `${message.deliveryId}:${campaignId}`,
    );
    expect(await redis.hget(keys.counters(campaignId), 'accepted')).toBe('1');
  });

  it('never sends a delivery twice, even when its message arrives several times', async () => {
    const campaignId = await sendingCampaign();
    const message = await prepare('919810000012', campaignId);

    await publisher.publishBatch('wa-send-p2', deliverySend, [
      { data: message },
      { data: message },
      { data: message },
    ]);

    await eventually(async () => (await delivery(message.deliveryId))?.status === 'accepted');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sentTo(message.deliveryId)).toBe(1);
    expect(await redis.hget(keys.counters(campaignId), 'accepted')).toBe('1');
  });

  it('records a delivery sent before a crash without sending it again', async () => {
    const campaignId = await sendingCampaign();
    const message = await prepare('919810000003', campaignId);
    // As if a sender called Meta, then died before its batch was written.
    await redis.set(keys.claim(message.deliveryId), 'ok:wamid.before-crash', 'EX', 60);

    await publisher.publish('wa-send-p2', deliverySend, message);

    const stored = await eventually(async () => {
      const d = await delivery(message.deliveryId);
      return d?.status === 'accepted' ? d : undefined;
    });
    expect(stored.providerMessageId).toBe('wamid.before-crash');
    expect(sentTo(message.deliveryId)).toBe(0);
  });

  it('skips deliveries of a stopped campaign and leaves a paused one pending', async () => {
    const stopped = await prepare('919810000004', await sendingCampaign('stopped'));
    const paused = await prepare('919810000005', await sendingCampaign('paused'));

    await publisher.publishBatch('wa-send-p2', deliverySend, [{ data: stopped }, { data: paused }]);

    await eventually(async () => (await delivery(stopped.deliveryId))?.status === 'skipped');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await delivery(paused.deliveryId))?.status).toBe('pending');
    expect(sentTo(stopped.deliveryId) + sentTo(paused.deliveryId)).toBe(0);
  });

  it('skips a suppressed number', async () => {
    await redis.sadd(keys.suppressed(), '919810000006');
    const message = await prepare('919810000006', await sendingCampaign());

    await publisher.publish('wa-send-p2', deliverySend, message);

    const stored = await eventually(async () => {
      const d = await delivery(message.deliveryId);
      return d?.status === 'skipped' ? d : undefined;
    });
    expect(stored.skipReason).toBe('suppressed');
    await redis.srem(keys.suppressed(), '919810000006');
  });

  it('keeps the claim when the result is unknown, and lists the delivery for the sweeper', async () => {
    // mock-meta accepts …0002 but holds its response past the client's timeout.
    const message = await prepare('919820000002');

    await publisher.publish('wa-send-p1', deliverySend, message);

    await eventually(
      async () =>
        (await redis.zscore(keys.unconfirmed(), message.deliveryId)) !== null &&
        sentTo(message.deliveryId) === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await redis.get(keys.claim(message.deliveryId))).toBe('inflight');
    expect((await delivery(message.deliveryId))?.status).toBe('pending');
  });

  it('pauses a campaign whose template Meta does not know, keeping its deliveries pending', async () => {
    const campaignId = await sendingCampaign();
    const message = await prepare('919810000007', campaignId);

    await publisher.publish('wa-send-p2', deliverySend, message);

    await eventually(async () => (await redis.get(keys.campaignPauseRequest(campaignId))) !== null);
    expect(await redis.get(keys.campaignState(campaignId))).toBe('paused');
    expect((await delivery(message.deliveryId))?.status).toBe('pending');
  });

  it('marks a direct message failed when Meta refuses it for good', async () => {
    const message = await prepare('919810000007');

    await publisher.publish('wa-send-p1', deliverySend, message);

    const stored = await eventually(async () => {
      const d = await delivery(message.deliveryId);
      return d?.status === 'failed' ? d : undefined;
    });
    expect(stored.error).toMatchObject({ code: 132001 });
  });

  it('slows down when Meta rate-limits the number, and still sends everything exactly once', async () => {
    await fetch(`${meta.url}/_sim/config`, { method: 'PATCH', body: JSON.stringify({ mps: 15 }) });
    const campaignId = await sendingCampaign();
    const messages = await Promise.all(
      Array.from({ length: 40 }, (_, i) => prepare(`9198300${String(100 + i).padStart(5, '0')}`, campaignId)),
    );

    await publisher.publishBatch(
      'wa-send-p2',
      deliverySend,
      messages.map((data) => ({ data, groupId: campaignId })),
    );

    await eventually(
      async () =>
        (await deliveries.countDocuments({
          campaignId: new Types.ObjectId(campaignId),
          status: 'accepted',
        })) === 40,
      25_000,
    );
    expect(messages.every((m) => sentTo(m.deliveryId) === 1)).toBe(true);
    expect(Number(await redis.hget(keys.rate(PHONE_NUMBER_ID), 'rate'))).toBeLessThan(80);
    await fetch(`${meta.url}/_sim/config`, { method: 'PATCH', body: JSON.stringify({ mps: 1000 }) });
    await redis.del(
      keys.rate(PHONE_NUMBER_ID),
      keys.bucket(PHONE_NUMBER_ID),
      keys.numberPause(PHONE_NUMBER_ID),
    );
  }, 40_000);

  it('pauses the account on an expired token, and stops taking messages off the queue', async () => {
    const message = await prepare('919810000004');

    await publisher.publish('wa-send-p1', deliverySend, message);

    await eventually(async () => (await redis.get(keys.accountPaused('main'))) !== null);
    const account = await t.app
      .get<Connection>(getConnectionToken(DB.messaging))
      .collection('wa_accounts')
      .findOne({ _id: 'main' as never });
    expect(account).toMatchObject({ status: 'paused' });
    expect((await delivery(message.deliveryId))?.status).toBe('pending');
    await redis.del(keys.accountPaused('main'));
  });
});
