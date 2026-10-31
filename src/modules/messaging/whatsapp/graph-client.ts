import { classifyMetaError, readMetaError, type Classification } from './meta-errors.js';
import type { TemplatePayload } from './template.js';

/**
 * Meta's Graph API for WhatsApp: sends, media, templates and phone-number fields. Plain TypeScript, so a
 * Lambda can use it too. Keep-alive comes from Node's `fetch`; there are no retries here, because retrying
 * is the queue's job (docs/modules/messaging/design.md#http-client).
 */
export interface GraphClientOptions {
  /** `https://graph.facebook.com`, or mock-meta locally. */
  readonly baseUrl: string;
  readonly version: string;
  readonly accessToken: string;
  /** Whole-request timeout for sends; template and media calls get twice this. Default 10 s. */
  readonly timeoutMs?: number;
  /** For tests. */
  readonly fetch?: typeof fetch;
}

export type SendEndpoint = 'messages' | 'marketing_messages';

export type MessageContent =
  | { readonly kind: 'template'; readonly template: TemplatePayload }
  | { readonly kind: 'text'; readonly text: string };

export interface SendRequest {
  readonly phoneNumberId: string;
  readonly endpoint: SendEndpoint;
  readonly to: string;
  readonly content: MessageContent;
  /** Echoed by Meta in status webhooks: `d:<deliveryId>` (ADR-0015). */
  readonly callbackData?: string;
}

export type SendResult =
  | { readonly ok: true; readonly wamid: string }
  | ({
      readonly ok: false;
      readonly code: number | undefined;
      readonly detail: string;
      readonly httpStatus: number | undefined;
    } & Classification);

/** A Meta template as listed by `/{waba}/message_templates`. */
export interface GraphTemplate {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly category: string;
  readonly quality: string;
  readonly components: readonly unknown[];
}

/** The phone number's quality and throughput, from `/{phone-number-id}`. */
export interface GraphPhoneNumber {
  readonly qualityRating: string | undefined;
  readonly throughputLevel: string | undefined;
  readonly messagingLimit: string | undefined;
}

/** A non-send Graph call failed. `code` is Meta's error code, when it sent one. */
export interface GraphFailure {
  readonly ok: false;
  readonly code: number | undefined;
  readonly detail: string;
}

/**
 * Errors raised before a request reaches Meta: the send certainly didn't happen, so it can be retried.
 * Anything else (a reset socket, our own timeout) may have reached Meta: the result is ambiguous.
 */
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function errorCode(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = current.cause;
  }
  return undefined;
}

export class GraphClient {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GraphClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Sends one message. Never throws: every outcome is a result, classified for the sender. */
  async send(request: SendRequest): Promise<SendResult> {
    const message =
      request.content.kind === 'template'
        ? { type: 'template', template: request.content.template }
        : { type: 'text', text: { preview_url: false, body: request.content.text } };
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: request.to,
      ...message,
      ...(request.callbackData === undefined ? {} : { biz_opaque_callback_data: request.callbackData }),
    };

    let response: Response;
    try {
      response = await this.request(`/${request.phoneNumberId}/${request.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const code = errorCode(error);
      const detail = `network error: ${code ?? (error instanceof Error ? error.name : 'unknown')}`;
      const failureClass = code !== undefined && NOT_SENT.has(code) ? 'retryable' : 'ambiguous';
      return { ok: false, class: failureClass, code: undefined, detail, httpStatus: undefined };
    }

    const json: unknown = await response.json().catch(() => null);
    const wamid = (json as { messages?: { id?: unknown }[] } | null)?.messages?.[0]?.id;
    if (response.ok && typeof wamid === 'string') return { ok: true, wamid };

    const { code, detail } = readMetaError(json);
    // A 5xx without a Meta error code may have been sent: Meta doesn't say. Treat it as retryable, as
    // HeliumAdmin does; the claim (ADR-0015) keeps a retry from reaching a recipient twice.
    return { ok: false, ...classifyMetaError(code), code, detail, httpStatus: response.status };
  }

  /** Uploads a media file for template headers. Meta keeps it for 30 days. */
  async uploadMedia(
    phoneNumberId: string,
    file: { readonly data: Uint8Array; readonly mime: string; readonly filename: string },
  ): Promise<{ readonly ok: true; readonly mediaId: string } | GraphFailure> {
    const form = new FormData();
    form.append('file', new Blob([file.data], { type: file.mime }), file.filename);
    form.append('type', file.mime);
    form.append('messaging_product', 'whatsapp');
    const result = await this.call(`/${phoneNumberId}/media`, { method: 'POST', body: form });
    if (!result.ok) return result;
    const id = (result.json as { id?: unknown }).id;
    return typeof id === 'string'
      ? { ok: true, mediaId: id }
      : { ok: false, code: undefined, detail: 'no media id' };
  }

  /** Every template of the WhatsApp Business Account, following Meta's paging. */
  async listTemplates(
    wabaId: string,
  ): Promise<{ readonly ok: true; readonly templates: GraphTemplate[] } | GraphFailure> {
    const fields = 'id,name,language,status,category,quality_score,components';
    const templates: GraphTemplate[] = [];
    let path: string | undefined =
      `/${wabaId}/message_templates?limit=100&fields=${encodeURIComponent(fields)}`;
    while (path !== undefined) {
      const result = await this.call(path, { method: 'GET' });
      if (!result.ok) return result;
      const page = result.json as { data?: Record<string, unknown>[]; paging?: { next?: string } };
      for (const item of page.data ?? []) templates.push(toTemplate(item));
      path = page.paging?.next;
      // The access token goes with every request: follow paging links only on the Graph API itself.
      if (path !== undefined && !path.startsWith(`${this.options.baseUrl}/`)) {
        return { ok: false, code: undefined, detail: 'paging link outside the Graph API' };
      }
    }
    return { ok: true, templates };
  }

  /** The phone number's quality rating, throughput level and messaging limit. */
  async getPhoneNumber(
    phoneNumberId: string,
  ): Promise<{ readonly ok: true; readonly phone: GraphPhoneNumber } | GraphFailure> {
    const fields = 'quality_rating,throughput,whatsapp_business_manager_messaging_limit';
    const result = await this.call(`/${phoneNumberId}?fields=${encodeURIComponent(fields)}`, {
      method: 'GET',
    });
    if (!result.ok) return result;
    const json = result.json as {
      quality_rating?: string;
      throughput?: { level?: string };
      whatsapp_business_manager_messaging_limit?: string;
    };
    return {
      ok: true,
      phone: {
        qualityRating: json.quality_rating,
        throughputLevel: json.throughput?.level,
        messagingLimit: json.whatsapp_business_manager_messaging_limit,
      },
    };
  }

  private async call(
    path: string,
    init: RequestInit,
  ): Promise<{ readonly ok: true; readonly json: unknown } | GraphFailure> {
    try {
      const response = await this.request(path, init, this.timeoutMs * 2);
      const json: unknown = await response.json().catch(() => null);
      if (response.ok && typeof json === 'object' && json !== null) return { ok: true, json };
      return { ok: false, ...readMetaError(json) };
    } catch (error) {
      return { ok: false, code: undefined, detail: `network error: ${errorCode(error) ?? 'unknown'}` };
    }
  }

  private request(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    // Paging links from Meta are absolute URLs.
    const url = path.startsWith('http') ? path : `${this.options.baseUrl}/${this.options.version}${path}`;
    return this.fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${this.options.accessToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

function toTemplate(item: Record<string, unknown>): GraphTemplate {
  const quality = item['quality_score'];
  const score =
    typeof quality === 'string'
      ? quality
      : typeof quality === 'object' && quality !== null
        ? (quality as { score?: unknown }).score
        : undefined;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    id: text(item['id']),
    name: text(item['name']),
    language: text(item['language']),
    status: text(item['status']).toUpperCase(),
    category: text(item['category']).toUpperCase(),
    quality: typeof score === 'string' ? score.toUpperCase() : 'UNKNOWN',
    components: Array.isArray(item['components']) ? (item['components'] as unknown[]) : [],
  };
}
