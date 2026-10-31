import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infrastructure/database/index.js';
import { DEFAULT_TEMPLATES } from '../tools/mock-meta/fixtures.ts';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { applyMigrations } from './helpers/migrations.js';
import { isolatedDatabases } from './helpers/mongo.js';
import { signToken } from './helpers/tokens.js';

const token = (roles: string[]) => signToken({ act: { id: 'admin-1', email: 'admin@heliumair.in', roles } });

describe('campaign drafts and uploads (API)', () => {
  const original = { ...process.env };
  let t: TestApp;
  let db: Connection;
  let admin: string;

  beforeAll(async () => {
    isolatedDatabases('campaigns');
    t = await createTestApp();
    db = t.app.get<Connection>(getConnectionToken(DB.messaging));
    await applyMigrations(db);
    // The template mirror, as the sync leaves it (mock-meta's templates).
    await db.collection('templates').deleteMany({ accountId: 'main' });
    await db.collection('templates').insertMany(
      DEFAULT_TEMPLATES.map((tpl) => ({
        _id: tpl.id as never,
        accountId: 'main',
        name: tpl.name,
        language: tpl.language,
        category: tpl.category,
        status: tpl.status,
        quality: tpl.quality_score.score,
        components: tpl.components,
        syncedAt: new Date(),
      })),
    );
    admin = await token(['admin']);
  });

  afterAll(async () => {
    await t.app.close();
    process.env = { ...original };
  });

  const api = (method: 'get' | 'post' | 'patch' | 'delete', path: string, auth = admin) =>
    request(t.http)[method](`/internal/v1${path}`).set('Authorization', `Bearer ${auth}`);

  const poll = {
    name: 'Air quality poll',
    templateId: '900000000000002',
    variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'name' }],
    audience: { sources: [{ type: 'users', filters: { registeredFrom: '2026-01-01' } }] },
  };

  it('lists synced templates with their variables, header media and poll options', async () => {
    const res = await api('get', '/templates?status=APPROVED');

    expect(res.status).toBe(200);
    const offer = (res.body as { items: { name: string }[] }).items.find((i) => i.name === 'diwali_offer');
    expect(offer).toMatchObject({ headerMediaType: 'image', quickReplies: ['Stop promotions'] });
    expect((res.body as { items: unknown[] }).items).toHaveLength(4);
  });

  it('creates a valid draft with default options, and records it in the audit log', async () => {
    const res = await api('post', '/campaigns').send(poll);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Air quality poll',
      status: 'draft',
      version: 0,
      template: { id: '900000000000002', name: 'purifier_poll', category: 'MARKETING' },
      options: { frequencyCapHours: 24, attributionDays: 7 },
      createdBy: { service: 'helium-admin', userId: 'admin-1', email: 'admin@heliumair.in' },
    });
    const id = (res.body as { id: string }).id;
    expect(await db.collection('audit_log').findOne({ 'entity.id': id })).toMatchObject({
      action: 'campaign.create',
    });
  });

  it('lists every problem with an invalid draft at once', async () => {
    const res = await api('post', '/campaigns').send({
      name: 'Broken',
      templateId: '900000000000001',
      variableMapping: [{ component: 'BODY', index: 1, source: 'field', value: 'csv:offer' }],
      audience: { sources: [] },
      options: { sendWindow: { start: '10:00', end: '10:00' }, frequencyCapHours: 24, attributionDays: 7 },
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'CAMPAIGN_INVALID' });
    expect((res.body as { details: { problems: string[] } }).details.problems).toEqual([
      'Body {{2}} is not mapped.',
      'A variable uses the CSV column "offer", but the audience has no CSV.',
      'The template needs a header image.',
      'Choose an audience: customers, a CSV, individual contacts or an earlier campaign.',
      'The send window starts and ends at the same time.',
    ]);
  });

  it('refuses a paused template', async () => {
    const res = await api('post', '/campaigns').send({
      ...poll,
      templateId: '900000000000005',
      variableMapping: [],
    });

    expect(res.status).toBe(422);
    expect((res.body as { details: { problems: string[] } }).details.problems).toContain(
      'The template is paused, not approved.',
    );
  });

  it('accepts header media, a CSV audience with its columns as variables, and an auto-reply', async () => {
    const media = await api('post', '/media').attach('file', Buffer.from([0xff, 0xd8, 0xff]), {
      filename: 'banner.jpg',
      contentType: 'image/jpeg',
    });
    expect(media.status).toBe(201);
    expect(media.body).toMatchObject({ type: 'image', mime: 'image/jpeg' });

    const csv = await api('post', '/uploads/csv').attach(
      'file',
      Buffer.from('Phone,Name,Offer\n9876543210,Asha,20%\n9876500000,Ravi,25%\n'),
      {
        filename: 'audience.csv',
        contentType: 'text/csv',
      },
    );
    expect(csv.status).toBe(201);
    expect(csv.body).toMatchObject({ rows: 2, columns: ['Phone', 'Name', 'Offer'], phoneColumn: 'Phone' });

    const res = await api('post', '/campaigns').send({
      name: 'Diwali offer',
      templateId: '900000000000001',
      headerMediaId: (media.body as { id: string }).id,
      variableMapping: [
        { component: 'BODY', index: 1, source: 'field', value: 'csv:Name' },
        { component: 'BODY', index: 2, source: 'field', value: 'csv:Offer' },
        { component: 'BUTTONS', buttonIndex: 0, index: 1, source: 'static', value: 'diwali' },
      ],
      audience: { csvUploadId: (csv.body as { id: string }).id, sources: [] },
      options: {
        frequencyCapHours: 0,
        sendWindow: { start: '10:00', end: '21:00' },
        maxMps: 40,
        attributionDays: 3,
      },
      autoReply: { enabled: true, mode: 'template', trigger: 'any_button', templateId: '900000000000004' },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      headerMedia: { type: 'image' },
      autoReply: { mode: 'template', template: { name: 'thank_you', language: 'en' } },
      options: { maxMps: 40, sendWindow: { start: '10:00', end: '21:00' } },
    });
  });

  it('refuses a CSV without a phone column', async () => {
    const res = await api('post', '/uploads/csv').attach('file', Buffer.from('name,city\nAsha,Pune\n'), {
      filename: 'x.csv',
    });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'CSV_INVALID' });
  });

  it('edits, duplicates and deletes drafts, and refuses to edit a campaign past draft', async () => {
    const created = (await api('post', '/campaigns').send(poll)).body as { id: string };

    const edited = await api('patch', `/campaigns/${created.id}`).send({ name: 'Renamed poll' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Renamed poll', version: 1 });

    const copy = await api('post', `/campaigns/${created.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ name: 'Copy of Renamed poll', status: 'draft' });

    await db
      .collection('campaigns')
      .updateOne(
        { _id: new (await import('mongoose')).Types.ObjectId(created.id) },
        { $set: { status: 'building' } },
      );
    const refused = await api('patch', `/campaigns/${created.id}`).send({ name: 'Again' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CAMPAIGN_STATE_CONFLICT' });

    const deleted = await api('delete', `/campaigns/${(copy.body as { id: string }).id}`);
    expect(deleted.status).toBe(204);
    expect((await api('get', `/campaigns/${(copy.body as { id: string }).id}`)).status).toBe(404);
  });

  it('lists campaigns newest first, filtered by status, in pages', async () => {
    const page = await api('get', '/campaigns?status=draft&limit=1');

    expect(page.status).toBe(200);
    const body = page.body as { items: { status: string }[]; nextCursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.items.every((c) => c.status === 'draft')).toBe(true);
    expect(body.nextCursor).not.toBeNull();
  });

  it('replays a retried create with the same Idempotency-Key instead of creating twice', async () => {
    const first = await api('post', '/campaigns').set('Idempotency-Key', 'create-poll-1').send(poll);
    const retry = await api('post', '/campaigns').set('Idempotency-Key', 'create-poll-1').send(poll);

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect((retry.body as { id: string }).id).toBe((first.body as { id: string }).id);
  });

  it('allows each role only its permissions', async () => {
    expect((await api('get', '/campaigns', await token(['viewer']))).status).toBe(200);
    expect((await api('post', '/campaigns', await token(['viewer'])).send(poll)).status).toBe(403);
    expect((await api('get', '/campaigns', await token(['support']))).status).toBe(403);
    expect((await api('post', '/campaigns', await token(['marketing'])).send(poll)).status).toBe(201);
    expect((await api('post', '/templates/sync', await token(['marketing']))).status).toBe(403);
  });
});
