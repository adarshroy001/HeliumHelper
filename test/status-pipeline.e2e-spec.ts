import type { AddressInfo } from 'node:net';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Redis } from 'ioredis';
import { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infrastructure/database/index.js';
import { QueuePublisher } from '../src/infrastructure/queue/index.js';
import { Delivery } from '../src/modules/messaging/data/delivery.schema.js';
import { keys } from '../src/modules/messaging/messaging.keys.js';
import { deliverySend } from '../src/modules/messaging/messaging.messages.js';
import { WorkerModule } from '../src/worker.module.js';
import { startMockMeta, type MockMeta } from '../tools/mock-meta/mock-meta.ts';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { applyMigrations } from './helpers/migrations.js';
import { isolatedDatabases } from './helpers/mongo.js';
import { isolatedRedis } from './helpers/redis.js';
import { isolatedQueues, testSqsClient } from './helpers/sqs.js';

const APP_SECRET = 'test-app-secret-0123456789';

async function eventually(check: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('status pipeline: send → Meta → webhook → statuses (API, worker, mock-meta)', () => {
  const original = { ...process.env };
  let api: TestApp;
  let worker: TestApp;
  let meta: MockMeta;
  let deliveries: Model<Delivery>;
  let redis: Redis;

  beforeAll(async () => {
    isolatedDatabases('pipeline');
    isolatedRedis(2);
    const sqs = testSqsClient();
    await isolatedQueues(sqs, 'pipeline-', [
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
      latencyMs: { p50: 2, p99: 10 },
      mps: 1000,
      statusDelayMs: 20,
      readRatio: 0.5,
      // Plenty of Meta's untidiness: duplicates, `delivered` skipped, statuses overtaking each other.
      duplicateRatio: 0.3,
      skipDeliveredRatio: 0.2,
    });
    process.env['WA_GRAPH_URL'] = meta.url;
    process.env['WORKER_QUEUES'] = 'wa-send-p2,wa-status';
    worker = await createTestApp({ module: WorkerModule });
    await applyMigrations(worker.app.get<Connection>(getConnectionToken(DB.messaging)));
    deliveries = worker.app.get<Model<Delivery>>(getModelToken(Delivery.name, DB.messaging));
    redis = worker.app.get(Redis);
  });

  afterAll(async () => {
    await meta.close();
    await worker.app.close();
    await api.app.close();
    process.env = { ...original };
  });

  it('ends with exact statuses and counters for 60 deliveries, failures included', async () => {
    const campaignId = new Types.ObjectId();
    const cid = String(campaignId);
    await redis.set(keys.campaignState(cid), 'sending');
    // …0001: failed after sent (131026); …0003: failed without sent (131049); the rest succeed.
    const phones = Array.from(
      { length: 60 },
      (_, i) => `91984${String(i === 7 ? 1 : i === 9 ? 3 : 100 + i).padStart(7, '0')}`,
    );
    const payload = {
      kind: 'template' as const,
      template: { name: 'diwali_offer', language: { code: 'en' } },
    };
    const docs = phones.map((to, seq) => ({
      _id: new Types.ObjectId(),
      source: { kind: 'campaign', id: cid },
      campaignId,
      seq,
      dedupeKey: `${cid}:${to}`,
      accountId: 'main',
      to,
      payload,
      status: 'pending',
      statusRank: 0,
      createdAt: new Date(),
    }));
    await deliveries.collection.insertMany(docs);

    await worker.app.get(QueuePublisher).publishBatch(
      'wa-send-p2',
      deliverySend,
      docs.map((d) => ({
        data: {
          deliveryId: String(d._id),
          accountId: 'main',
          // Its own number, so other test files' rate limits on the shared Redis don't slow it down.
          phoneNumberId: '100000000000009',
          to: d.to,
          endpoint: 'marketing_messages' as const,
          campaignId: cid,
          payload,
          businessInitiated: true,
        },
        groupId: cid,
      })),
    );

    // Settled: every delivery is at its final status, and webhooks have stopped arriving.
    await eventually(async () => {
      await meta.emitter?.drain();
      const pending = await deliveries.countDocuments({
        campaignId,
        status: { $in: ['pending', 'accepted'] },
      });
      return pending === 0 && meta.emitter?.stats.pendingStatuses === 0;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const byStatus = Object.fromEntries(
      (
        await deliveries.aggregate<{ _id: string; n: number }>([
          { $match: { campaignId } },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ])
      ).map((g) => [g._id, g.n]),
    );
    const counters = await redis.hgetall(keys.counters(cid));
    const number = (field: string) => Number(counters[field] ?? 0);

    expect(byStatus['failed']).toBe(2);
    expect((byStatus['delivered'] ?? 0) + (byStatus['read'] ?? 0)).toBe(58);
    // Counters count deliveries that ever reached a state, once each, despite duplicates and reordering.
    // The …0003 message is accepted by Meta, then fails without being sent.
    expect(number('accepted')).toBe(60);
    expect(number('sent')).toBe(59);
    expect(number('delivered')).toBe(58);
    expect(number('read')).toBe(byStatus['read'] ?? 0);
    expect(number('failed')).toBe(2);
    expect(number('billable:marketing')).toBe(59);
    expect(meta.sent.filter((m) => m.callbackData?.endsWith(cid) === true)).toHaveLength(60);
    const failedAfterSent = await deliveries.findOne({ campaignId, to: phones[7] }).lean<Delivery>();
    expect(failedAfterSent).toMatchObject({ status: 'failed', error: { code: 131026 } });
    expect(failedAfterSent?.sentAt).toBeInstanceOf(Date);
  }, 60_000);
});
