// mock-meta: a local fake of Meta's Graph API for WhatsApp (docs/PLAN.md M4). Accepts sends on /messages and
// /marketing_messages with a per-number rate limit and realistic latency, answers some recipients with errors,
// and sends signed status webhooks back, with duplicates, reordering and skipped `delivered`.
//
// Errors by the recipient's last four digits:
//   0001 accepted, then `failed` 131026 after `sent`      0005 131016 on the first try, accepted on a retry
//   0002 accepted, but the response hangs (ambiguous)    0006 131056 (pair rate limit)
//   0003 accepted, then `failed` 131049 (no `sent`)       0007 132001 (template doesn't exist)
//   0004 190 (token expired)
//
// Test controls: POST /_sim/inbound, POST /_sim/account, GET|DELETE /_sim/sent, GET /_sim/stats, PATCH /_sim/config.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_TEMPLATES, type MockTemplate } from './fixtures.ts';
import { WebhookEmitter } from './webhook-emitter.ts';

export interface MockMetaOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Where status and inbound webhooks go; none are sent when unset. */
  webhookUrl?: string;
  appSecret: string;
  /** When set, requests must carry it as a Bearer token. */
  accessToken?: string;
  wabaId?: string;
  displayPhone?: string;
  /** Sends allowed per second per phone number before 130429. */
  mps?: number;
  latencyMs?: { p50: number; p99: number };
  /** Delay before the first status of a send. */
  statusDelayMs?: number;
  readRatio?: number;
  duplicateRatio?: number;
  skipDeliveredRatio?: number;
  /** How long a `…0002` response hangs. */
  hangMs?: number;
  random?: () => number;
}

export interface SentMessage {
  wamid: string;
  to: string;
  phoneNumberId: string;
  endpoint: string;
  type: string;
  template?: string;
  callbackData?: string;
  at: string;
}

export interface MockMeta {
  url: string;
  sent: SentMessage[];
  emitter: WebhookEmitter | undefined;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;
type Settings = Required<Omit<MockMetaOptions, 'port' | 'webhookUrl' | 'accessToken' | 'random'>>;

const error = (code: number, message: string) => ({ error: { code, message, type: 'OAuthException' } });

export async function startMockMeta(options: MockMetaOptions): Promise<MockMeta> {
  const random = options.random ?? Math.random;
  const settings: Settings = {
    appSecret: options.appSecret,
    wabaId: options.wabaId ?? '100000000000001',
    displayPhone: options.displayPhone ?? '15550001111',
    mps: options.mps ?? 80,
    latencyMs: options.latencyMs ?? { p50: 40, p99: 250 },
    statusDelayMs: options.statusDelayMs ?? 100,
    readRatio: options.readRatio ?? 0.5,
    duplicateRatio: options.duplicateRatio ?? 0.02,
    skipDeliveredRatio: options.skipDeliveredRatio ?? 0.05,
    hangMs: options.hangMs ?? 15_000,
  };
  const emitter =
    options.webhookUrl === undefined
      ? undefined
      : new WebhookEmitter({
          url: options.webhookUrl,
          appSecret: settings.appSecret,
          wabaId: settings.wabaId,
          displayPhone: settings.displayPhone,
        });
  const sent: SentMessage[] = [];
  const buckets = new Map<string, { tokens: number; at: number }>();
  const retriedOnce = new Set<string>();
  const stats = { sends: 0, accepted: 0, rateLimited: 0, errors: 0 };
  let templates: MockTemplate[] = DEFAULT_TEMPLATES;

  const latency = () => {
    const { p50, p99 } = settings.latencyMs;
    return random() < 0.95 ? p50 * (0.5 + random()) : p50 + (p99 - p50) * random();
  };
  const later = (ms: number, action: () => void) => setTimeout(action, Math.max(0, ms)).unref();

  function takeToken(phoneNumberId: string): boolean {
    const now = Date.now();
    const bucket = buckets.get(phoneNumberId) ?? { tokens: settings.mps, at: now };
    bucket.tokens = Math.min(settings.mps, bucket.tokens + ((now - bucket.at) / 1000) * settings.mps);
    bucket.at = now;
    buckets.set(phoneNumberId, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  function emitStatuses(message: SentMessage, outcome: 'ok' | 131026 | 131049): void {
    if (emitter === undefined) return;
    // Like Meta: priced by the template's category; free text inside the window is a service message.
    const category =
      message.template === undefined
        ? 'service'
        : (templates.find((t) => t.name === message.template)?.category.toLowerCase() ?? 'utility');
    const base = {
      id: message.wamid,
      recipient_id: message.to,
      ...(message.callbackData === undefined ? {} : { biz_opaque_callback_data: message.callbackData }),
    };
    const status = (name: string, extra: Json = {}) => ({
      ...base,
      status: name,
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...extra,
    });
    const pricing = { pricing: { billable: true, pricing_model: 'PMP', category, type: 'regular' } };
    const failed = (code: number, title: string) =>
      status('failed', { errors: [{ code, title, message: title, error_data: { details: title } }] });
    const send = (ms: number, build: () => Json) =>
      later(ms, () => {
        const value = build();
        emitter.status(message.phoneNumberId, value);
        if (random() < settings.duplicateRatio) emitter.status(message.phoneNumberId, value);
      });

    const start = settings.statusDelayMs;
    if (outcome === 131049) {
      send(start, () =>
        failed(131049, 'This message was not delivered to maintain healthy ecosystem engagement.'),
      );
      return;
    }
    send(start, () => status('sent', pricing));
    if (outcome === 131026) {
      send(start * 3, () => failed(131026, 'Message undeliverable'));
      return;
    }
    // Jitter lets `delivered` sometimes overtake `sent`, as Meta's webhooks do. Like Meta, `delivered` is only
    // ever skipped for a message that is read.
    const read = random() < settings.readRatio;
    if (!read || random() >= settings.skipDeliveredRatio)
      send(start + start * 2 * random(), () => status('delivered', pricing));
    if (read) send(start * 5 + start * 5 * random(), () => status('read'));
  }

  async function handleSend(phoneNumberId: string, endpoint: string, body: Json, res: ServerResponse) {
    stats.sends += 1;
    const to = typeof body['to'] === 'string' ? body['to'] : '';
    const type = typeof body['type'] === 'string' ? body['type'] : '';
    if (body['messaging_product'] !== 'whatsapp' || to === '' || (type !== 'template' && type !== 'text')) {
      stats.errors += 1;
      reply(res, 400, error(100, 'Invalid parameter'));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, latency()));
    if (!takeToken(phoneNumberId)) {
      stats.rateLimited += 1;
      reply(res, 400, error(130429, 'Rate limit hit'));
      return;
    }
    const suffix = to.slice(-4);
    const syncErrors: Record<string, [number, string]> = {
      '0004': [190, 'Error validating access token: Session has expired'],
      '0006': [131056, 'Pair rate limit hit'],
      '0007': [132001, 'Template name does not exist in the translation'],
    };
    const syncError = syncErrors[suffix];
    if (suffix === '0005' && !retriedOnce.has(to)) {
      retriedOnce.add(to);
      stats.errors += 1;
      reply(res, 503, error(131016, 'Service temporarily unavailable'));
      return;
    }
    if (syncError !== undefined) {
      stats.errors += 1;
      reply(res, 400, error(...syncError));
      return;
    }

    const template = body['template'] as { name?: unknown } | undefined;
    const callbackData = body['biz_opaque_callback_data'];
    const message: SentMessage = {
      wamid: `wamid.${randomUUID()}`,
      to,
      phoneNumberId,
      endpoint,
      type,
      ...(typeof template?.name === 'string' ? { template: template.name } : {}),
      ...(typeof callbackData === 'string' ? { callbackData } : {}),
      at: new Date().toISOString(),
    };
    sent.push(message);
    stats.accepted += 1;
    emitStatuses(message, suffix === '0001' ? 131026 : suffix === '0003' ? 131049 : 'ok');
    if (suffix === '0002') await new Promise((resolve) => setTimeout(resolve, settings.hangMs));
    reply(res, 200, {
      messaging_product: 'whatsapp',
      contacts: [{ input: to, wa_id: to }],
      messages: [{ id: message.wamid }],
    });
  }

  function simulate(path: string, method: string, body: Json, res: ServerResponse): void {
    if (path === '/_sim/sent' && method === 'GET') {
      const byCallback = new Map<string, number>();
      for (const message of sent) {
        if (message.callbackData !== undefined) {
          byCallback.set(message.callbackData, (byCallback.get(message.callbackData) ?? 0) + 1);
        }
      }
      const duplicates = [...byCallback].filter(([, count]) => count > 1).map(([key]) => key);
      reply(res, 200, { total: sent.length, duplicates, messages: sent });
    } else if (path === '/_sim/sent' && method === 'DELETE') {
      sent.length = 0;
      retriedOnce.clear();
      reply(res, 200, { ok: true });
    } else if (path === '/_sim/stats' && method === 'GET') {
      reply(res, 200, { ...stats, webhooks: emitter?.stats });
    } else if (path === '/_sim/config' && method === 'PATCH') {
      Object.assign(settings, body);
      reply(res, 200, settings);
    } else if (path === '/_sim/templates' && method === 'PUT') {
      templates = Array.isArray(body['templates'])
        ? (body['templates'] as MockTemplate[])
        : DEFAULT_TEMPLATES;
      reply(res, 200, { count: templates.length });
    } else if (path === '/_sim/inbound' && method === 'POST') {
      const wamid = `wamid.in.${randomUUID()}`;
      const from = typeof body['from'] === 'string' ? body['from'] : '';
      const button = body['button'] as { text?: string; payload?: string } | undefined;
      const context =
        typeof body['contextWamid'] === 'string'
          ? { context: { from: settings.displayPhone, id: body['contextWamid'] } }
          : {};
      const content =
        button === undefined
          ? { type: 'text', text: { body: typeof body['text'] === 'string' ? body['text'] : '' } }
          : {
              type: 'button',
              button: { text: button.text ?? '', payload: button.payload ?? button.text ?? '' },
            };
      emitter?.inbound(
        typeof body['phoneNumberId'] === 'string' ? body['phoneNumberId'] : '100000000000002',
        {
          contacts: [
            { profile: { name: typeof body['name'] === 'string' ? body['name'] : 'Customer' }, wa_id: from },
          ],
          messages: [
            { from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), ...context, ...content },
          ],
        },
      );
      reply(res, 200, { wamid });
    } else if (path === '/_sim/account' && method === 'POST') {
      emitter?.account(String(body['field']), (body['value'] ?? {}) as Json);
      reply(res, 200, { ok: true });
    } else {
      reply(res, 404, { error: 'unknown simulator route' });
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock-meta');
    const method = req.method ?? 'GET';
    const raw = await readBody(req);
    if (url.pathname.startsWith('/_sim/')) {
      simulate(url.pathname, method, parseJson(raw), res);
      return;
    }
    if (options.accessToken !== undefined && req.headers.authorization !== `Bearer ${options.accessToken}`) {
      reply(res, 401, error(190, 'Invalid OAuth access token'));
      return;
    }
    const [, , id, action] = url.pathname.split('/');
    if (method === 'POST' && id !== undefined && (action === 'messages' || action === 'marketing_messages')) {
      await handleSend(id, action, parseJson(raw), res);
    } else if (method === 'POST' && action === 'media') {
      reply(res, 200, { id: `media-${randomUUID()}` });
    } else if (method === 'GET' && action === 'message_templates') {
      reply(res, 200, { data: templates, paging: { cursors: { before: 'a', after: 'b' } } });
    } else if (method === 'GET' && id !== undefined && action === undefined) {
      reply(res, 200, {
        id,
        quality_rating: 'GREEN',
        throughput: { level: 'STANDARD' },
        whatsapp_business_manager_messaging_limit: 'TIER_100K',
      });
    } else {
      reply(res, 404, error(100, 'Unknown path'));
    }
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch(() => {
      reply(res, 500, error(2, 'mock-meta failed'));
    });
  });
  server.keepAliveTimeout = 65_000;
  await new Promise<void>((resolve) => server.listen(options.port ?? 4010, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    sent,
    emitter,
    close: async () => {
      emitter?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function parseJson(raw: string): Json {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Json) : {};
  } catch {
    return {};
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
