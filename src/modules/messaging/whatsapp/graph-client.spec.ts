import { describe, expect, it, vi } from 'vitest';
import { GraphClient } from './graph-client.js';

const template = { name: 'offer', language: { code: 'en' } };

function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  // The client always calls fetch with a URL string.
  const fetchMock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(respond(url, init ?? {})));
  const graph = new GraphClient({
    baseUrl: 'https://graph.test',
    version: 'v26.0',
    accessToken: 'token-1',
    fetch: fetchMock as typeof fetch,
  });
  return { graph, fetchMock };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const metaError = (code: number, message = 'error') => ({ error: { code, message } });

function networkError(code: string) {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

describe('GraphClient.send', () => {
  it('posts the message with callback data to the chosen endpoint', async () => {
    const { graph, fetchMock } = client(() => json(200, { messages: [{ id: 'wamid.1' }] }));

    const result = await graph.send({
      phoneNumberId: '111',
      endpoint: 'marketing_messages',
      to: '919876543210',
      content: { kind: 'template', template },
      callbackData: 'd:abc',
    });

    expect(result).toEqual({ ok: true, wamid: 'wamid.1' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://graph.test/v26.0/111/marketing_messages');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer token-1');
    expect(JSON.parse(init?.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      template,
      biz_opaque_callback_data: 'd:abc',
    });
  });

  it('sends free text without a link preview', async () => {
    const { graph, fetchMock } = client(() => json(200, { messages: [{ id: 'wamid.2' }] }));

    await graph.send({
      phoneNumberId: '111',
      endpoint: 'messages',
      to: '91',
      content: { kind: 'text', text: 'Hello' },
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      type: 'text',
      text: { preview_url: false, body: 'Hello' },
    });
  });

  it.each([
    [131026, { class: 'permanent' }],
    [130429, { class: 'rate_limited' }],
    [190, { class: 'fatal', fatalScope: 'account' }],
    [131016, { class: 'retryable' }],
  ])('classifies Meta error %i', async (code, classification) => {
    const { graph } = client(() => json(400, metaError(code, 'Meta says no')));

    const result = await graph.send({
      phoneNumberId: '1',
      endpoint: 'messages',
      to: '9',
      content: { kind: 'text', text: 'x' },
    });

    expect(result).toEqual({ ok: false, ...classification, code, detail: 'Meta says no', httpStatus: 400 });
  });

  it('treats a 5xx without an error body as retryable', async () => {
    const { graph } = client(() => new Response('bad gateway', { status: 502 }));

    const result = await graph.send({
      phoneNumberId: '1',
      endpoint: 'messages',
      to: '9',
      content: { kind: 'text', text: 'x' },
    });

    expect(result).toMatchObject({ ok: false, class: 'retryable', httpStatus: 502 });
  });

  it('retries connection failures, which never reached Meta', async () => {
    const { graph } = client(() => {
      throw networkError('ECONNREFUSED');
    });

    const result = await graph.send({
      phoneNumberId: '1',
      endpoint: 'messages',
      to: '9',
      content: { kind: 'text', text: 'x' },
    });

    expect(result).toEqual({
      ok: false,
      class: 'retryable',
      code: undefined,
      detail: 'network error: ECONNREFUSED',
      httpStatus: undefined,
    });
  });

  it.each([
    ['a reset socket', networkError('ECONNRESET')],
    ['our timeout', Object.assign(new DOMException('timed out', 'TimeoutError'))],
  ])('marks %s as ambiguous: the send may have happened', async (_name, error) => {
    const { graph } = client(() => {
      throw error;
    });

    const result = await graph.send({
      phoneNumberId: '1',
      endpoint: 'messages',
      to: '9',
      content: { kind: 'text', text: 'x' },
    });

    expect(result).toMatchObject({ ok: false, class: 'ambiguous' });
  });
});

describe('GraphClient other calls', () => {
  it('lists templates across pages, normalizing quality and case', async () => {
    const { graph, fetchMock } = client((url) =>
      url.includes('after=2')
        ? json(200, {
            data: [
              {
                id: '2',
                name: 'b',
                language: 'en',
                status: 'paused',
                category: 'utility',
                quality_score: 'red',
              },
            ],
          })
        : json(200, {
            data: [
              {
                id: '1',
                name: 'a',
                language: 'en',
                status: 'APPROVED',
                category: 'MARKETING',
                quality_score: { score: 'GREEN' },
                components: [{ type: 'BODY' }],
              },
            ],
            paging: { next: 'https://graph.test/v26.0/waba/message_templates?after=2' },
          }),
    );

    const result = await graph.listTemplates('waba');

    expect(result).toEqual({
      ok: true,
      templates: [
        {
          id: '1',
          name: 'a',
          language: 'en',
          status: 'APPROVED',
          category: 'MARKETING',
          quality: 'GREEN',
          components: [{ type: 'BODY' }],
        },
        {
          id: '2',
          name: 'b',
          language: 'en',
          status: 'PAUSED',
          category: 'UTILITY',
          quality: 'RED',
          components: [],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses to follow a paging link to another host, so the token stays with Meta', async () => {
    const { graph, fetchMock } = client(() =>
      json(200, { data: [], paging: { next: 'https://evil.test/steal' } }),
    );

    expect(await graph.listTemplates('waba')).toEqual({
      ok: false,
      code: undefined,
      detail: 'paging link outside the Graph API',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uploads media as multipart and returns the media ID', async () => {
    const { graph, fetchMock } = client(() => json(200, { id: 'media-9' }));

    const result = await graph.uploadMedia('111', {
      data: new Uint8Array([1, 2]),
      mime: 'image/png',
      filename: 'a.png',
    });

    expect(result).toEqual({ ok: true, mediaId: 'media-9' });
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('messaging_product')).toBe('whatsapp');
    expect(body.get('type')).toBe('image/png');
  });

  it('reads phone-number quality, throughput and limit', async () => {
    const { graph } = client(() =>
      json(200, {
        quality_rating: 'GREEN',
        throughput: { level: 'STANDARD' },
        whatsapp_business_manager_messaging_limit: 'TIER_10K',
      }),
    );

    expect(await graph.getPhoneNumber('111')).toEqual({
      ok: true,
      phone: { qualityRating: 'GREEN', throughputLevel: 'STANDARD', messagingLimit: 'TIER_10K' },
    });
  });

  it('returns Meta errors and network failures as results', async () => {
    const failing = client(() => json(401, metaError(190, 'Token expired')));
    expect(await failing.graph.getPhoneNumber('1')).toEqual({
      ok: false,
      code: 190,
      detail: 'Token expired',
    });

    const offline = client(() => {
      throw networkError('ENOTFOUND');
    });
    expect(await offline.graph.listTemplates('w')).toEqual({
      ok: false,
      code: undefined,
      detail: 'network error: ENOTFOUND',
    });
  });
});
