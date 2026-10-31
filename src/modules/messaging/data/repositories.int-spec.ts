import mongoose, { type Connection, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase } from '../../../../test/helpers/mongo.js';
import { applyMigrations } from '../../../../test/helpers/migrations.js';
import { DeliveriesRepository } from './deliveries.repository.js';
import { Delivery, DeliverySchema, type DeliveryStatus } from './delivery.schema.js';
import {
  AccountsRepository,
  ConversationsRepository,
  InboundMessagesRepository,
  SuppressionsRepository,
} from './messaging.repositories.js';
import {
  Conversation,
  ConversationSchema,
  InboundMessage,
  InboundMessageSchema,
  Suppression,
  SuppressionSchema,
  WaAccount,
  WaAccountSchema,
} from './messaging.schemas.js';

// As the app sets it (src/infrastructure/database/database.module.ts).
mongoose.set('strictQuery', 'throw');

describe('messaging repositories (real MongoDB)', () => {
  let db: Connection & { dropAndClose: () => Promise<void> };
  let deliveries: DeliveriesRepository;
  const models = () => ({
    delivery: db.model(Delivery.name, DeliverySchema),
    account: db.model(WaAccount.name, WaAccountSchema),
    inbound: db.model(InboundMessage.name, InboundMessageSchema),
    conversation: db.model(Conversation.name, ConversationSchema),
    suppression: db.model(Suppression.name, SuppressionSchema),
  });

  beforeAll(async () => {
    db = await connectTestDatabase();
    await applyMigrations(db);
    deliveries = new DeliveriesRepository(models().delivery);
  });

  afterAll(async () => {
    await db.dropAndClose();
  });

  beforeEach(async () => {
    const names = ['deliveries', 'wa_accounts', 'inbound_messages', 'conversations', 'suppressions'];
    await Promise.all(names.map((name) => db.collection(name).deleteMany({})));
  });

  it('creates every index, and applies again without changes', async () => {
    // Forget that they ran, so every migration runs again over the existing collections.
    await db.collection('_migrations').deleteMany({});
    await applyMigrations(db);
    const native = db.db;
    if (native === undefined) throw new Error('no database handle');

    const names = (await native.collection('deliveries').indexes()).map((index) => index.name).sort();
    expect(names).toEqual([
      '_id_',
      'campaign_seq',
      'campaign_status_seq',
      'dedupe_key',
      'provider_message_id',
      'to_created',
    ]);
    const ttl = (await native.collection('unmatched_statuses').indexes()).find(
      (index) => index.name === 'expire_at',
    );
    expect(ttl?.expireAfterSeconds).toBe(0);
  });

  const campaignId = new Types.ObjectId();
  const delivery = (to: string, extra: Partial<Delivery> = {}) => ({
    _id: new Types.ObjectId(),
    source: { kind: 'campaign' as const, id: String(campaignId) },
    campaignId,
    seq: Number(to.slice(-3)),
    dedupeKey: `${String(campaignId)}:${to}`,
    accountId: 'main',
    to,
    payload: { kind: 'text' as const, text: 'hi' },
    status: 'pending' as const,
    statusRank: 0,
    createdAt: new Date(),
    ...extra,
  });
  const statusOf = async (id: Types.ObjectId | string) =>
    (await models().delivery.findById(id).lean<{ status: DeliveryStatus; providerMessageId?: string }>())
      ?.status;

  describe('deliveries', () => {
    it('skips duplicate recipients and counts them, so a re-run batch is safe', async () => {
      const batch = [delivery('919800000001'), delivery('919800000002')];
      expect(await deliveries.insertMany(batch)).toEqual({ inserted: 2, duplicates: 0 });

      const rerun = [delivery('919800000001'), delivery('919800000003')];
      expect(await deliveries.insertMany(rerun)).toEqual({ inserted: 1, duplicates: 1 });
      expect(await models().delivery.countDocuments()).toBe(3);
    });

    it('records accepted with its wamid, and the wamid even when a status got there first', async () => {
      const early = delivery('919800000011');
      const late = delivery('919800000012');
      await deliveries.insertMany([early, late]);
      await deliveries.applyStatuses([
        { id: String(late._id), status: 'sent', at: new Date(), wamid: 'wamid.late' },
      ]);

      await deliveries.applySendOutcomes([
        { id: String(early._id), result: 'accepted', wamid: 'wamid.early', at: new Date() },
        { id: String(late._id), result: 'accepted', wamid: 'wamid.late', at: new Date() },
      ]);

      expect(await statusOf(early._id)).toBe('accepted');
      expect(await statusOf(late._id)).toBe('sent');
      expect(await deliveries.findByWamid('wamid.early')).toEqual({
        deliveryId: String(early._id),
        campaignId: String(campaignId),
      });
    });

    it('applies statuses only upwards: reordering, duplicates and late events change nothing', async () => {
      const d = delivery('919800000021');
      await deliveries.insertMany([d]);
      const id = String(d._id);
      const at = new Date();

      await deliveries.applyStatuses([
        { id, status: 'delivered', at, wamid: 'wamid.21' },
        { id, status: 'sent', at, wamid: 'wamid.21' },
        { id, status: 'delivered', at, wamid: 'wamid.21' },
      ]);
      expect(await statusOf(d._id)).toBe('delivered');

      await deliveries.applyStatuses([
        { id, status: 'failed', at, wamid: 'wamid.21', error: { code: 131026, title: 'x', at } },
      ]);
      expect(await statusOf(d._id)).toBe('delivered');

      await deliveries.applyStatuses([{ id, status: 'read', at, wamid: 'wamid.21' }]);
      expect(await statusOf(d._id)).toBe('read');
    });

    it('accepts failed after sent, and nothing after failed', async () => {
      const d = delivery('919800000031');
      await deliveries.insertMany([d]);
      const id = String(d._id);
      const at = new Date();

      await deliveries.applyStatuses([
        { id, status: 'sent', at, wamid: 'wamid.31', pricing: { category: 'marketing', billable: true } },
      ]);
      await deliveries.applyStatuses([
        { id, status: 'failed', at, wamid: 'wamid.31', error: { code: 131026, title: 'Undeliverable', at } },
      ]);
      await deliveries.applyStatuses([{ id, status: 'delivered', at, wamid: 'wamid.31' }]);

      const stored = await deliveries.findById(id);
      expect(stored).toMatchObject({
        status: 'failed',
        error: { code: 131026 },
        pricing: { category: 'marketing' },
      });
    });

    it('skips only pending deliveries', async () => {
      const pending = delivery('919800000041');
      const accepted = delivery('919800000042');
      await deliveries.insertMany([pending, accepted]);
      await deliveries.applySendOutcomes([
        { id: String(accepted._id), result: 'accepted', wamid: 'wamid.42', at: new Date() },
      ]);

      await deliveries.applySendOutcomes([
        { id: String(pending._id), result: 'skipped', reason: 'stopped', at: new Date() },
        { id: String(accepted._id), result: 'skipped', reason: 'stopped', at: new Date() },
      ]);

      expect(await statusOf(pending._id)).toBe('skipped');
      expect(await statusOf(accepted._id)).toBe('accepted');
    });

    it('works with deterministic string IDs, as auto-replies use', async () => {
      await deliveries.insertMany([
        delivery('919800000051', {
          _id: 'ar-abe62b6b7c967a6d606cc0cc',
          dedupeKey: undefined,
          campaignId: undefined,
        }),
      ]);
      await deliveries.applySendOutcomes([
        { id: 'ar-abe62b6b7c967a6d606cc0cc', result: 'accepted', wamid: 'wamid.ar', at: new Date() },
      ]);

      expect(await statusOf('ar-abe62b6b7c967a6d606cc0cc')).toBe('accepted');
      expect(
        await deliveries.insertMany([
          delivery('919800000051', { _id: 'ar-abe62b6b7c967a6d606cc0cc', dedupeKey: undefined }),
        ]),
      ).toEqual({
        inserted: 0,
        duplicates: 1,
      });
    });
  });

  it('stores an inbound message once, whatever the duplicates', async () => {
    const repo = new InboundMessagesRepository(models().inbound);
    const message = {
      _id: 'wamid.in.1',
      accountId: 'main',
      from: '919800000001',
      type: 'text',
      text: 'Hi',
      receivedAt: new Date(),
    };

    expect([...(await repo.insertNew([message, { ...message, _id: 'wamid.in.2' }]))]).toEqual([
      'wamid.in.1',
      'wamid.in.2',
    ]);
    expect([...(await repo.insertNew([message, { ...message, _id: 'wamid.in.3' }]))]).toEqual(['wamid.in.3']);
  });

  it('keeps the latest message per conversation and counts unread replies', async () => {
    const repo = new ConversationsRepository(models().conversation);
    const t = (s: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, s));

    await repo.record([
      { phone: '919800000001', accountId: 'main', direction: 'outbound', at: t(1), preview: 'Diwali offer' },
      {
        phone: '919800000001',
        accountId: 'main',
        direction: 'inbound',
        at: t(3),
        preview: 'Yes',
        name: 'Asha',
      },
      { phone: '919800000001', accountId: 'main', direction: 'inbound', at: t(2), preview: 'Hello' },
    ]);

    expect(await models().conversation.findById('919800000001').lean()).toMatchObject({
      lastMessageAt: t(3),
      lastInboundAt: t(3),
      unread: 2,
      name: 'Asha',
    });
    await repo.markRead('919800000001');
    expect(await models().conversation.findById('919800000001').lean()).toMatchObject({ unread: 0 });
  });

  it('adds suppressions once, keeping the first reason, and streams them all', async () => {
    const repo = new SuppressionsRepository(models().suppression);

    expect(await repo.add([{ _id: '919800000001', reason: 'keyword', source: 'wamid.in.1' }])).toBe(1);
    expect(
      await repo.add([
        { _id: '919800000001', reason: 'admin' },
        { _id: '919800000002', reason: 'admin' },
      ]),
    ).toBe(1);
    expect(await models().suppression.findById('919800000001').lean()).toMatchObject({ reason: 'keyword' });

    const batches: string[][] = [];
    for await (const batch of repo.allPhones(1)) batches.push(batch);
    expect(batches.flat().sort()).toEqual(['919800000001', '919800000002']);
    expect(await repo.remove('919800000002')).toBe(true);
  });

  it('seeds the account from config without undoing a pause', async () => {
    const repo = new AccountsRepository(models().account);
    const fromConfig = {
      _id: 'main',
      wabaId: '1',
      phoneNumberId: '2',
      portfolioId: '3',
      marketingEndpoint: 'messages' as const,
      maxMps: 80,
    };

    await repo.upsertFromConfig(fromConfig);
    await repo.setStatus('main', 'paused', 'token expired');
    await repo.upsertFromConfig({ ...fromConfig, maxMps: 250 });

    expect(await repo.findById('main')).toMatchObject({
      status: 'paused',
      pauseReason: 'token expired',
      maxMps: 250,
    });
  });
});
