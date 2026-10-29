import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { resolveRequestId } from '../request-context/request-id.js';
import { toErrorBody } from './error-response.js';

/**
 * Turns every exception thrown while handling a request, including Nest's own (unknown route, bad JSON), into
 * the error contract `{ statusCode, code, message, details?, requestId }` (ADR-0008).
 *
 * Logging: the access log already writes one line per request, at warn for 4xx and error for 5xx. For a 5xx the
 * exception is attached to that line, so each failure is logged once, with its stack. 4xx errors are expected
 * and add nothing beyond the warn line.
 *
 * A request rejected before the logging middleware runs (a body too large or not valid JSON: the body parser runs
 * first) has no access log line, so it is logged here instead, as `request rejected`.
 */
@Catch()
export class ExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<IncomingMessage>();
    const res = http.getResponse<ServerResponse>();
    const { httpAdapter } = this.adapterHost;
    const body = toErrorBody(exception);

    if (body.statusCode >= 500) {
      // pino-http logs `res.err`, with its stack, in this request's access log line.
      res.err = exception instanceof Error ? exception : new Error('Non-Error thrown', { cause: exception });
    }

    // A response that has started streaming can't be replaced with an error body.
    if (httpAdapter.isHeadersSent(res)) {
      httpAdapter.end(res);
      return;
    }
    const requestId = resolveRequestId(req, res);
    httpAdapter.reply(res, { ...body, requestId }, body.statusCode);

    // pino-http sets `req.log` when it sees a request (its types claim it is always there). Logged after the
    // reply so the access log serializers read the same fields as on a normal access log line.
    if ((req as { log?: unknown }).log === undefined) {
      this.logger.warn({ requestId, req, res }, 'request rejected');
    }
  }
}
