import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function request(header?: string | string[]): IncomingMessage {
  return { headers: header === undefined ? {} : { [REQUEST_ID_HEADER]: header } } as IncomingMessage;
}

function response(): ServerResponse & { headers: Record<string, unknown> } {
  const headers: Record<string, unknown> = {};
  return {
    headers,
    headersSent: false,
    hasHeader: (name: string) => name in headers,
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
    },
  } as unknown as ServerResponse & { headers: Record<string, unknown> };
}

describe('resolveRequestId', () => {
  it('generates a UUID when the caller sends none', () => {
    expect(resolveRequestId(request())).toMatch(UUID);
  });

  it('reuses a safe caller ID', () => {
    expect(resolveRequestId(request('order-123:retry.2'))).toBe('order-123:retry.2');
  });

  it.each([['has spaces'], ['line\nbreak'], ['x'.repeat(129)], [['a', 'b']]])(
    'replaces an unsafe caller ID (%j)',
    (header) => {
      expect(resolveRequestId(request(header))).toMatch(UUID);
    },
  );

  it('returns the same ID on every call for one request', () => {
    const req = request();
    const first = resolveRequestId(req);
    expect(resolveRequestId(req)).toBe(first);
    expect(resolveRequestId(req, response())).toBe(first);
  });

  it('sets the response header once', () => {
    const req = request('abc');
    const res = response();
    resolveRequestId(req, res);
    expect(res.headers[REQUEST_ID_HEADER]).toBe('abc');
  });
});
