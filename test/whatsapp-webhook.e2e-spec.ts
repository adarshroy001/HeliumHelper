import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { SQSClient } from '@aws-sdk/client-sqs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueuePublisher } from '../src/infrastructure/queue/index.js';
import { GraphClient } from '../src/modules/messaging/index.js';
import { startMockMeta } from '../tools/mock-meta/mock-meta.ts';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { createTestQueue, receiveAll, testSqsClient, type TestQueue } from './helpers/sqs.js';

// The app secret and verify token Vitest configures (vitest.config.ts).
const APP_SECRET = 'test-app-secret-0123456789';
const VERIFY_TOKEN = 'test-verify-token-0123';

const metadata = { display_phone_number: '15550001111', phone_number_id: '100000000000002' };
const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '100000000000001',
      changes: [
        { field: 'messages', value: { metadata, statuses: [{ id: 'wamid.1', status: 'delivered' }] } },
        {
          field: 'messages',
          value: { metadata, messages: [{ id: 'wamid.in', from: '919876543210', type: 'text' }] },
        },
        { field: 'phone_number_quality_update', value: { event: 'FLAGGED', current_limit: 'TIER_1K' } },
      ],
    },
  ],
};

function post(t: TestApp, body: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(body);
  return request(t.http)
    .post('/webhooks/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`)
    .send(raw);
}

describe('WhatsApp webhook intake', () => {
  let sqs: SQSClient;
  let queues: Record<'status' | 'inbound' | 'account', TestQueue>;
  let t: TestApp;

  beforeAll(async () => {
    sqs = testSqsClient();
    queues = {
      status: await createTestQueue(sqs, { name: 'wa-status' }),
      inbound: await createTestQueue(sqs, { name: 'wa-inbound' }),
      account: await createTestQueue(sqs, { name: 'wa-account' }),
    };
    t = await createTestApp();
  });

  beforeEach(async () => {
    for (const queue of Object.values(queues)) await receiveAll(sqs, queue.url);
  });

  afterAll(async () => {
    await t.app.close();
    sqs.destroy();
  });

  const bodies = async (queue: TestQueue) =>
    (await receiveAll(sqs, queue.url)).map(
      (m) => JSON.parse(m.Body ?? '{}') as { type: string; data: unknown },
    );

  it("answers Meta's verification challenge as plain text", async () => {
    const res = await request(t.http)
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('1158201444');
  });

  it('refuses verification with the wrong token', async () => {
    const res = await request(t.http)
      .get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WEBHOOK_VERIFICATION_FAILED' });
  });

  it('queues each change on its queue and answers 200 with an empty body', async () => {
    const res = await post(t, payload);

    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(await bodies(queues.status)).toEqual([
      expect.objectContaining({
        type: 'wa.webhook.status',
        data: expect.objectContaining({
          wabaId: '100000000000001',
          phoneNumberId: '100000000000002',
          field: 'messages',
          value: { metadata, statuses: [{ id: 'wamid.1', status: 'delivered' }] },
        }) as unknown,
      }),
    ]);
    expect(await bodies(queues.inbound)).toEqual([expect.objectContaining({ type: 'wa.webhook.inbound' })]);
    expect(await bodies(queues.account)).toEqual([
      expect.objectContaining({
        type: 'wa.webhook.account',
        data: expect.objectContaining({ field: 'phone_number_quality_update' }) as unknown,
      }),
    ]);
  });

  it('refuses a bad signature with 401 and queues nothing', async () => {
    const res = await post(t, payload, 'not-the-app-secret-0123456789');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    expect(await bodies(queues.status)).toEqual([]);
  });

  it('refuses a request without a signature', async () => {
    const res = await request(t.http).post('/webhooks/whatsapp').send(payload);

    expect(res.status).toBe(401);
  });

  it('accepts a signed payload it cannot use, so Meta stops retrying it', async () => {
    const res = await post(t, { object: 'page', entry: [] });

    expect(res.status).toBe(200);
  });

  it('needs no token and is not counted by the caller rate limit', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => post(t, payload)));

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  });
});

describe('WhatsApp webhook intake when the queue is down', () => {
  it('answers 503 so Meta retries the webhook', async () => {
    const failing = {
      publishBatch: () => Promise.reject(new Error('SQS unavailable')),
    };
    const t = await createTestApp({ override: (b) => b.overrideProvider(QueuePublisher).useValue(failing) });

    const res = await post(t, payload);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'WEBHOOK_NOT_QUEUED' });
    await t.app.close();
  });
});

describe('mock-meta → webhook route', () => {
  it("delivers mock-meta's signed status webhooks to the real route, which queues them", async () => {
    const sqs = testSqsClient();
    const status = await createTestQueue(sqs, { name: 'wa-status' });
    await receiveAll(sqs, status.url);
    const t = await createTestApp();
    await t.app.listen(0);
    const { port } = t.http.address() as AddressInfo;
    const meta = await startMockMeta({
      port: 0,
      webhookUrl: `http://127.0.0.1:${String(port)}/webhooks/whatsapp`,
      appSecret: APP_SECRET,
      latencyMs: { p50: 1, p99: 2 },
      statusDelayMs: 5,
      readRatio: 1,
      duplicateRatio: 0,
      skipDeliveredRatio: 0,
    });
    const graph = new GraphClient({ baseUrl: meta.url, version: 'v26.0', accessToken: 'any' });

    const result = await graph.send({
      phoneNumberId: '100000000000002',
      endpoint: 'messages',
      to: '919800000000',
      content: { kind: 'text', text: 'hello' },
      callbackData: 'd:e2e',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await meta.emitter?.drain();
    const queued = (await receiveAll(sqs, status.url)).flatMap((m) => {
      const body = JSON.parse(m.Body ?? '{}') as { data: { value: { statuses: { status: string }[] } } };
      return body.data.value.statuses.map((s) => s.status);
    });

    expect(result).toMatchObject({ ok: true });
    expect(meta.emitter?.stats.failed).toBe(0);
    expect(queued.sort()).toEqual(['delivered', 'read', 'sent']);
    await meta.close();
    await t.app.close();
    sqs.destroy();
  });
});
