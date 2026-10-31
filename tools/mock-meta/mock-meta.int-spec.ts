import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GraphClient } from '../../src/modules/messaging/whatsapp/graph-client.ts';
import { isValidSignature } from '../../src/modules/messaging/whatsapp/webhook.ts';
import { startMockMeta, type MockMeta } from './mock-meta.ts';

const APP_SECRET = 'mock-meta-test-secret-0123';
let numbers = 0;
/** A fresh phone number ID, so each test has its own rate bucket. */
const pn = () => String(500 + (numbers += 1));
const template = { kind: 'template' as const, template: { name: 'diwali_offer', language: { code: 'en' } } };

interface Received {
  valid: boolean;
  body: { entry: { changes: { field: string; value: Record<string, unknown> }[] }[] };
}

/** A tiny webhook receiver standing in for the backend. */
async function startReceiver(): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const signature = req.headers['x-hub-signature-256'];
      received.push({
        valid: isValidSignature(raw, typeof signature === 'string' ? signature : undefined, [APP_SECRET]),
        body: JSON.parse(raw.toString('utf8')) as Received['body'],
      });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(port)}/webhooks/whatsapp`, received };
}

describe('mock-meta', () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  let meta: MockMeta;
  let graph: GraphClient;

  beforeAll(async () => {
    receiver = await startReceiver();
    meta = await startMockMeta({
      port: 0,
      webhookUrl: receiver.url,
      appSecret: APP_SECRET,
      accessToken: 'token',
      mps: 5,
      latencyMs: { p50: 1, p99: 2 },
      statusDelayMs: 5,
      readRatio: 1,
      duplicateRatio: 0,
      skipDeliveredRatio: 0,
      hangMs: 300,
    });
    graph = new GraphClient({ baseUrl: meta.url, version: 'v26.0', accessToken: 'token', timeoutMs: 150 });
  });

  beforeEach(async () => {
    await fetch(`${meta.url}/_sim/sent`, { method: 'DELETE' });
    await meta.emitter?.drain();
    receiver.received.length = 0;
  });

  afterAll(async () => {
    await meta.close();
    receiver.server.close();
  });

  const statuses = () =>
    receiver.received.flatMap((r) =>
      r.body.entry.flatMap((e) =>
        e.changes.flatMap((c) => (c.value['statuses'] as Record<string, unknown>[] | undefined) ?? []),
      ),
    );

  it('accepts a send and reports sent, delivered and read in signed webhooks, echoing the callback data', async () => {
    const result = await graph.send({
      phoneNumberId: pn(),
      endpoint: 'marketing_messages',
      to: '919800000000',
      content: template,
      callbackData: 'd:1',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await meta.emitter?.drain();

    expect(result).toMatchObject({ ok: true });
    expect(receiver.received.every((r) => r.valid)).toBe(true);
    expect(
      statuses()
        .map((s) => s['status'])
        .sort(),
    ).toEqual(['delivered', 'read', 'sent']);
    expect(statuses().every((s) => s['biz_opaque_callback_data'] === 'd:1')).toBe(true);
    expect(statuses().find((s) => s['status'] === 'sent')?.['pricing']).toMatchObject({
      category: 'marketing',
      billable: true,
    });
  });

  it.each([
    ['919800000004', { class: 'fatal', code: 190 }],
    ['919800000006', { class: 'rate_limited', code: 131056 }],
    ['919800000007', { class: 'fatal', code: 132001 }],
  ])('answers %s with an error', async (to, expected) => {
    expect(
      await graph.send({ phoneNumberId: pn(), endpoint: 'messages', to, content: template }),
    ).toMatchObject({ ok: false, ...expected });
  });

  it('fails a …0005 send once, then accepts the retry', async () => {
    const phoneNumberId = pn();
    const send = () =>
      graph.send({ phoneNumberId, endpoint: 'messages', to: '919800000005', content: template });

    expect(await send()).toMatchObject({ ok: false, class: 'retryable', code: 131016 });
    expect(await send()).toMatchObject({ ok: true });
  });

  it('hangs a …0002 response past the timeout, though the message was sent', async () => {
    const result = await graph.send({
      phoneNumberId: pn(),
      endpoint: 'messages',
      to: '919800000002',
      content: template,
      callbackData: 'd:2',
    });

    expect(result).toMatchObject({ ok: false, class: 'ambiguous' });
    expect(meta.sent.map((m) => m.callbackData)).toEqual(['d:2']);
  });

  it('reports failed after sent for …0001', async () => {
    await graph.send({ phoneNumberId: pn(), endpoint: 'messages', to: '919800000001', content: template });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await meta.emitter?.drain();

    expect(statuses().map((s) => s['status'])).toEqual(['sent', 'failed']);
  });

  it('rate-limits a number beyond its messages per second with 130429', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        graph.send({ phoneNumberId: '333', endpoint: 'messages', to: '919811111111', content: template }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.code === 130429)).toHaveLength(3);
  });

  it('refuses a wrong access token', async () => {
    const stranger = new GraphClient({ baseUrl: meta.url, version: 'v26.0', accessToken: 'nope' });

    expect(
      await stranger.send({
        phoneNumberId: pn(),
        endpoint: 'messages',
        to: '919800000000',
        content: template,
      }),
    ).toMatchObject({ ok: false, code: 190 });
  });

  it('simulates an inbound reply and lists sends with duplicates', async () => {
    const inbound = await fetch(`${meta.url}/_sim/inbound`, {
      method: 'POST',
      body: JSON.stringify({ from: '919800000000', button: { text: 'Bedroom' }, contextWamid: 'wamid.x' }),
    });
    await meta.emitter?.drain();
    const message = receiver.received.at(-1)?.body.entry[0]?.changes[0]?.value['messages'] as Record<
      string,
      unknown
    >[];

    expect(inbound.status).toBe(200);
    expect(message[0]).toMatchObject({
      from: '919800000000',
      type: 'button',
      button: { text: 'Bedroom' },
      context: { id: 'wamid.x' },
    });

    await graph.send({
      phoneNumberId: '444',
      endpoint: 'messages',
      to: '919822222222',
      content: template,
      callbackData: 'd:9',
    });
    await graph.send({
      phoneNumberId: '444',
      endpoint: 'messages',
      to: '919822222222',
      content: template,
      callbackData: 'd:9',
    });
    const sent = (await (await fetch(`${meta.url}/_sim/sent`)).json()) as {
      total: number;
      duplicates: string[];
    };
    expect(sent).toMatchObject({ total: 2, duplicates: ['d:9'] });
  });

  it('serves templates and phone-number fields', async () => {
    const templates = await graph.listTemplates('100000000000001');
    const phone = await graph.getPhoneNumber('222');

    expect(templates.ok && templates.templates.map((t) => t.name)).toContain('purifier_poll');
    expect(phone).toEqual({
      ok: true,
      phone: { qualityRating: 'GREEN', throughputLevel: 'STANDARD', messagingLimit: 'TIER_100K' },
    });
  });
});
