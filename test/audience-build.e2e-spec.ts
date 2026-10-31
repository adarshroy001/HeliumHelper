import { getConnectionToken } from '@nestjs/mongoose';
import { Redis } from 'ioredis';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infrastructure/database/index.js';
import { messagingKeys } from '../src/modules/messaging/index.js';
import { WorkerModule } from '../src/worker.module.js';
import { DEFAULT_TEMPLATES } from '../tools/mock-meta/fixtures.ts';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { applyMigrations } from './helpers/migrations.js';
import { isolatedDatabases } from './helpers/mongo.js';
import { isolatedRedis } from './helpers/redis.js';
import { isolatedQueues, testSqsClient } from './helpers/sqs.js';
import { signToken } from './helpers/tokens.js';

async function eventually<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

describe('audience build (API, worker, main and messaging databases)', () => {
  const original = { ...process.env };
  let api: TestApp;
  let worker: TestApp;
  let main: Connection;
  let messaging: Connection;
  let redis: Redis;
  let auth: string;

  beforeAll(async () => {
    isolatedDatabases('audience');
    isolatedRedis(6);
    const sqs = testSqsClient();
    await isolatedQueues(sqs, 'audience-', ['campaign-control']);
    sqs.destroy();
    api = await createTestApp();
    process.env['WORKER_QUEUES'] = 'campaign-control';
    worker = await createTestApp({ module: WorkerModule });
    main = api.app.get<Connection>(getConnectionToken(DB.main));
    messaging = api.app.get<Connection>(getConnectionToken(DB.messaging));
    await applyMigrations(messaging);
    redis = api.app.get(Redis);
    auth = await signToken({ act: { id: 'a1', email: 'admin@heliumair.in', roles: ['admin'] } });

    await messaging.collection('templates').insertMany(
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
    // The storefront's data, as HeliumAdmin's audience code reads it.
    const at = new Date('2026-06-15T10:00:00Z');
    await main.collection('users').insertMany([
      { phone: '9870000001', name: 'User One', email: 'one@x.in', address: { city: 'Pune' }, createdAt: at },
      { phone: '+91 98700 00002', name: 'User Two', createdAt: at },
      { phone: '919870000003', name: 'Suppressed', createdAt: at },
      { phone: '9870000004', name: 'Recently messaged', createdAt: at },
      { phone: '12345', name: 'Invalid', createdAt: at },
      { phone: '9870000099', name: 'Csv person in users', createdAt: at },
    ]);
    await main.collection('orders').insertMany([
      {
        deliveryAddress: { phone: '9870000001', name: 'Order Name', city: 'Delhi' },
        status: 'delivered',
        createdAt: at,
      },
      { deliveryAddress: { phone: '9870000010', name: 'Buyer' }, status: 'delivered', createdAt: at },
      { deliveryAddress: { phone: '9870000010', name: 'Buyer again' }, status: 'delivered', createdAt: at },
      { deliveryAddress: { phone: '9870000011', name: 'Cancelled' }, status: 'cancelled', createdAt: at },
    ]);
    await main.collection('abandonedcarts').insertMany([
      { customer: { phone: '9870000020', name: 'Cart' }, status: 'open', createdAt: at },
      { customer: { phone: '9870000021', name: 'Converted' }, status: 'converted', createdAt: at },
    ]);
    await main
      .collection('newwaitlists')
      .insertOne({ phone: '9870000030', name: 'Wait', joinedAt: at, source: 'instagram' });
    await redis.sadd(messagingKeys.suppressed(), '919870000003');
    await messaging.collection('deliveries').insertOne({
      _id: new Types.ObjectId(),
      source: { kind: 'campaign' },
      campaignId: new Types.ObjectId(),
      dedupeKey: 'old:919870000004',
      accountId: 'main',
      to: '919870000004',
      payload: { kind: 'text', text: 'x' },
      status: 'delivered',
      statusRank: 3,
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    await redis.srem(messagingKeys.suppressed(), '919870000003');
    await worker.app.close();
    await api.app.close();
    process.env = { ...original };
  });

  const api$ = (method: 'get' | 'post', path: string) =>
    request(api.http)[method](`/internal/v1${path}`).set('Authorization', `Bearer ${auth}`);
  const campaign = async (id: string) =>
    (await api$('get', `/campaigns/${id}`)).body as {
      status: string;
      totals?: { total: number; skipped: Record<string, number> };
    };
  const deliveriesOf = (id: string) =>
    messaging
      .collection<{ to: string; name?: string; seq: number; status: string; payload: unknown }>('deliveries')
      .find({ campaignId: new Types.ObjectId(id) })
      .sort({ seq: 1 })
      .toArray();

  it('previews counts per source and a rendered sample', async () => {
    const res = await api$('post', '/audiences/preview').send({
      audience: {
        sources: [
          { type: 'users', filters: {} },
          { type: 'orders', filters: { status: ['delivered'] } },
        ],
      },
      templateId: '900000000000002',
      variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ breakdown: { users: 6, orders: 2 }, upperBound: 8, complete: true });
    expect((res.body as { sample: { body: string } }).sample.body).toMatch(
      /^Hi .+, which room needs cleaner air\?$/,
    );
  });

  it('builds every source in priority order, with exclusions, suppressions, the frequency cap and CSV variables', async () => {
    const csv = await api$('post', '/uploads/csv').attach(
      'file',
      Buffer.from('phone,name,offer\n9870000099,Csv Name,30%\n9870000040,Fresh,10%\n'),
      { filename: 'a.csv' },
    );
    const created = await api$('post', '/campaigns').send({
      name: 'All sources',
      templateId: '900000000000002',
      variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
      audience: {
        csvUploadId: (csv.body as { id: string }).id,
        sources: [
          { type: 'users', filters: {} },
          { type: 'orders', filters: { status: ['delivered'] } },
          { type: 'abandoned_carts', filters: {} },
          { type: 'waitlist', filters: {} },
        ],
        individual: [{ phone: '9870000050', name: 'Picked by hand' }],
        exclusions: { phones: ['98700 00002'] },
      },
      options: { frequencyCapHours: 24, attributionDays: 7 },
    });
    const id = (created.body as { id: string }).id;

    const build = await api$('post', `/campaigns/${id}/build`);
    expect(build.status).toBe(202);
    expect(build.body).toMatchObject({ status: 'building' });
    const ready = await eventually(async () => {
      const c = await campaign(id);
      return c.status === 'ready' ? c : null;
    });

    // csv 2 + users 6 + orders 2 + cart 1 + waitlist 1 + individual 1 = 13 candidates.
    expect(ready.totals).toEqual({
      total: 7,
      skipped: { invalid: 1, suppressed: 1, frequency: 1, excluded: 1, duplicate: 2 },
    });
    const rows = await deliveriesOf(id);
    expect(rows.map((d) => d.to)).toEqual([
      '919870000099',
      '919870000040',
      '919870000001',
      '919870000010',
      '919870000020',
      '919870000030',
      '919870000050',
    ]);
    // The CSV named 9870000099 first, so its name wins over the user record's.
    expect(rows[0]).toMatchObject({
      name: 'Csv Name',
      status: 'pending',
      payload: { kind: 'template', template: { name: 'purifier_poll' } },
    });
    expect(JSON.stringify(rows[0]?.payload)).toContain('Csv Name');
    expect(new Set(rows.map((d) => d.seq)).size).toBe(7);
  });

  it('retargets the recipients of an earlier campaign by outcome', async () => {
    const earlier = (
      await api$('post', '/campaigns').send({
        name: 'Earlier',
        templateId: '900000000000002',
        variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
        audience: {
          sources: [],
          individual: [
            { phone: '9870000061', name: 'A' },
            { phone: '9870000062', name: 'B' },
          ],
        },
        options: { frequencyCapHours: 0, attributionDays: 7 },
      })
    ).body as { id: string };
    await api$('post', `/campaigns/${earlier.id}/build`);
    await eventually(async () => (await campaign(earlier.id)).status === 'ready');
    await messaging
      .collection('campaigns')
      .updateOne({ _id: new Types.ObjectId(earlier.id) }, { $set: { status: 'send_complete' } });
    await messaging
      .collection('deliveries')
      .updateOne(
        { campaignId: new Types.ObjectId(earlier.id), to: '919870000061' },
        { $set: { status: 'read', statusRank: 4 } },
      );
    await messaging
      .collection('deliveries')
      .updateOne(
        { campaignId: new Types.ObjectId(earlier.id), to: '919870000062' },
        { $set: { status: 'read', statusRank: 4, reply: { count: 1 } } },
      );

    const followUp = (
      await api$('post', '/campaigns').send({
        name: 'Read but no reply',
        templateId: '900000000000002',
        variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
        audience: { sources: [], retarget: { campaignId: earlier.id, outcome: 'read_no_reply' } },
        options: { frequencyCapHours: 0, attributionDays: 7 },
      })
    ).body as { id: string };
    await api$('post', `/campaigns/${followUp.id}/build`);
    await eventually(async () => (await campaign(followUp.id)).status === 'ready');

    expect((await deliveriesOf(followUp.id)).map((d) => d.to)).toEqual(['919870000061']);
  });

  it('fails a build that ends up empty, saying why', async () => {
    const created = (
      await api$('post', '/campaigns').send({
        name: 'Only suppressed',
        templateId: '900000000000002',
        variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
        audience: { sources: [], individual: [{ phone: '9870000003', name: 'Suppressed' }] },
      })
    ).body as { id: string };
    await api$('post', `/campaigns/${created.id}/build`);

    const failed = await eventually(async () => {
      const c = await campaign(created.id);
      return c.status === 'build_failed' ? c : null;
    });
    expect(failed.totals).toMatchObject({ total: 0, skipped: { suppressed: 1 } });
    // The API says why, from the build record.
    const shown = await api$('get', `/campaigns/${created.id}`);
    expect(typeof (shown.body as { buildError: unknown }).buildError).toBe('string');
  });

  it('lists filter options from the data', async () => {
    const res = await api$('get', '/audiences/options');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ waitlistSources: ['instagram'], channels: ['d2c', 'dealer', 'amazon'] });
  });
});
