import type { AddressInfo } from 'node:net';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Redis } from 'ioredis';
import { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infrastructure/database/index.js';
import { Delivery } from '../src/modules/messaging/data/delivery.schema.js';
import { keys } from '../src/modules/messaging/messaging.keys.js';
import { WorkerModule } from '../src/worker.module.js';
import { startMockMeta, type MockMeta } from '../tools/mock-meta/mock-meta.ts';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { applyMigrations } from './helpers/migrations.js';
import { isolatedDatabases } from './helpers/mongo.js';
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

// Phones avoid the last digits 0001–0007, which make mock-meta answer with errors.
describe('inbound messages (API webhook, worker, mock-meta)', () => {
  const original = { ...process.env };
  let api: TestApp;
  let worker: TestApp;
  let meta: MockMeta;
  let db: Connection;
  let deliveries: Model<Delivery>;
  let redis: Redis;

  beforeAll(async () => {
    isolatedDatabases('inbound');
    const sqs = testSqsClient();
    await isolatedQueues(sqs, 'inbound-', [
      'wa-status',
      'wa-inbound',
      'wa-account',
      'wa-send-p1',
      'wa-send-p2',
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
      mps: 1000,
    });
    process.env['WA_GRAPH_URL'] = meta.url;
    process.env['WORKER_QUEUES'] = 'wa-inbound,wa-send-p1';
    worker = await createTestApp({ module: WorkerModule });
    db = worker.app.get<Connection>(getConnectionToken(DB.messaging));
    await applyMigrations(db);
    deliveries = worker.app.get<Model<Delivery>>(getModelToken(Delivery.name, DB.messaging));
    redis = worker.app.get(Redis);
  });

  afterAll(async () => {
    await meta.close();
    await worker.app.close();
    await api.app.close();
    process.env = { ...original };
  });

  /** A campaign message that went out to `to`, as the sender leaves it. */
  async function sentCampaignMessage(to: string, name = 'Asha') {
    const campaignId = String(new Types.ObjectId());
    const deliveryId = new Types.ObjectId();
    const wamid = `wamid.out.${String(deliveryId)}`;
    await deliveries.collection.insertOne({
      _id: deliveryId,
      source: { kind: 'campaign', id: campaignId },
      campaignId: new Types.ObjectId(campaignId),
      dedupeKey: `${campaignId}:${to}`,
      accountId: 'main',
      to,
      name,
      payload: { kind: 'template', template: { name: 'purifier_poll', language: { code: 'en' } } },
      status: 'delivered',
      statusRank: 3,
      providerMessageId: wamid,
      createdAt: new Date(),
    });
    await redis.set(keys.wamid(wamid), `${String(deliveryId)}:${campaignId}`);
    return { campaignId, deliveryId: String(deliveryId), wamid };
  }

  const reply = async (body: Record<string, unknown>) => {
    const res = await fetch(`${meta.url}/_sim/inbound`, { method: 'POST', body: JSON.stringify(body) });
    return ((await res.json()) as { wamid: string }).wamid;
  };
  const inboundDoc = (wamid: string) => db.collection('inbound_messages').findOne({ _id: wamid as never });

  it('stores a reply, attributes it to the campaign message it answers, and counts one vote per person', async () => {
    const { campaignId, deliveryId, wamid } = await sentCampaignMessage('919850000011');

    // A real customer's taps are seconds apart: the second is sent once the first is stored.
    const first = await reply({ from: '919850000011', button: { text: 'Bedroom' }, contextWamid: wamid });
    const stored = await eventually(() => inboundDoc(first));
    await reply({ from: '919850000011', button: { text: 'Office' }, contextWamid: wamid });
    expect(stored).toMatchObject({ from: '919850000011', type: 'button', deliveryId, campaignId });
    const delivery = await eventually(async () => {
      const d = await deliveries.findById(new Types.ObjectId(deliveryId)).lean<Delivery>();
      return d?.reply?.count === 2 ? d : null;
    });
    expect(delivery.reply).toMatchObject({ count: 2 });
    expect(await redis.hget(keys.counters(campaignId), 'replied')).toBe('1');
    expect(await redis.hgetall(keys.buttons(campaignId))).toEqual({ Bedroom: '1' });
    expect(await redis.ttl(keys.serviceWindow('919850000011'))).toBeGreaterThan(86_000);
    expect(await db.collection('conversations').findOne({ _id: '919850000011' as never })).toMatchObject({
      unread: 2,
      lastDirection: 'inbound',
    });
  });

  it('sends the campaign auto-reply once, however many times the customer taps', async () => {
    const { campaignId, deliveryId, wamid } = await sentCampaignMessage('919850000012', 'Ravi');
    await redis.set(
      keys.autoReply(campaignId),
      JSON.stringify({ trigger: 'any_button', mode: 'text', text: 'Thanks {{name}}!', choiceReplies: [] }),
    );

    await reply({ from: '919850000012', button: { text: 'Bedroom' }, contextWamid: wamid });
    await reply({ from: '919850000012', button: { text: 'Office' }, contextWamid: wamid });

    await eventually(() => Promise.resolve(meta.sent.some((m) => m.to === '919850000012')));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const replies = meta.sent.filter((m) => m.to === '919850000012');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'text', endpoint: 'messages' });
    const autoReply = await deliveries
      .findOne({ 'source.kind': 'auto_reply', 'source.id': deliveryId })
      .lean<Delivery>();
    expect(autoReply).toMatchObject({ status: 'accepted', payload: { kind: 'text', text: 'Thanks Ravi!' } });
  });

  it('opts a number out on STOP, and adds it to the suppression list once', async () => {
    const { campaignId, wamid } = await sentCampaignMessage('919850000013');

    await reply({ from: '919850000013', text: ' Stop ', contextWamid: wamid });
    await reply({ from: '919850000013', text: 'STOP' });

    await eventually(async () => (await redis.sismember(keys.suppressed(), '919850000013')) === 1);
    expect(await db.collection('suppressions').findOne({ _id: '919850000013' as never })).toMatchObject({
      reason: 'keyword',
    });
    expect(await redis.hget(keys.counters(campaignId), 'optedOut')).toBe('1');
    await redis.srem(keys.suppressed(), '919850000013');
  });

  it('keeps a message that answers nothing of ours, without attributing it', async () => {
    const wamid = await reply({ from: '919850000014', text: 'Do you deliver to Pune?' });

    const stored = await eventually(() => inboundDoc(wamid));
    expect(stored).toMatchObject({ text: 'Do you deliver to Pune?' });
    expect(stored).not.toHaveProperty('campaignId');
  });
});
