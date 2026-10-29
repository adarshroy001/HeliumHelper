import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { resolveRequestId } from '../request-context/request-id.js';
import { toErrorBody } from './error-response.js';

/**
 * Turns every exception thrown while handling a request, including Nest's own (unknown route, bad JSON), into
 * the error contract `{ statusCode, code, message, details?, requestId }` (ADR-0008).
 *
 * Logging: the access log already writes one line per request, at warn for 4xx and error for 5xx. For a 5xx the
 * exception is attached to that line, so each failure is logged once, with its stack. 4xx errors are expected
 * and add nothing beyond the warn line.
 */
@Catch()
export class ExceptionsFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

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
    httpAdapter.reply(res, { ...body, requestId: resolveRequestId(req, res) }, body.statusCode);
  }
}
