import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** A caller's ID is reused only if it is short and plain, so it can't inject text into logs. */
const SAFE_ID = /^[\w.:-]{1,128}$/;
const ID = Symbol('requestId');

type RequestWithId = IncomingMessage & { [ID]?: string };

/**
 * The one source of a request's ID, used by both the request context (nestjs-cls) and the access logger
 * (pino-http). The first call decides the ID and stores it on the request, so every later call returns the
 * same value whichever middleware runs first. When given the response, it also sets `X-Request-Id` on it.
 */
export function resolveRequestId(req: IncomingMessage, res?: ServerResponse): string {
  const request = req as RequestWithId;
  let id = request[ID];
  if (id === undefined) {
    const incoming = req.headers[REQUEST_ID_HEADER];
    id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    request[ID] = id;
  }
  if (res && !res.headersSent && !res.hasHeader(REQUEST_ID_HEADER)) {
    res.setHeader(REQUEST_ID_HEADER, id);
  }
  return id;
}
