import type { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { resolveRequestId } from './request-id.js';

/**
 * Per-request context (AsyncLocalStorage via nestjs-cls), available anywhere through `ClsService`.
 * Holds the request ID now; the acting user is added in F11. `ClsService.getId()` returns the same ID as the
 * logs and the `X-Request-Id` response header.
 */
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: IncomingMessage) => resolveRequestId(req),
      },
    }),
  ],
})
export class RequestContextModule {}
