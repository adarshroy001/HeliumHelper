import type { ServerResponse } from 'node:http';
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { getRequestActor } from '../../common/auth/index.js';
import { RateLimitedError } from '../../common/errors/index.js';

/**
 * The throttler's global guard, with two changes:
 * - limits count per caller: the calling service and its user, as verified by AuthGuard (which runs first);
 *   the client IP only for requests without one;
 * - an exceeded limit is the standard 429 `RATE_LIMITED` error with `details.retryAfterSeconds`, plus the
 *   standard `Retry-After` header.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const actor = getRequestActor(req);
    const ip = typeof req['ip'] === 'string' ? req['ip'] : 'unknown';
    return Promise.resolve(actor === undefined ? `ip:${ip}` : `${actor.service}:${actor.user?.id ?? '-'}`);
  }

  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfterSeconds = Math.max(1, detail.timeToBlockExpire);
    context.switchToHttp().getResponse<ServerResponse>().setHeader('Retry-After', retryAfterSeconds);
    throw new RateLimitedError(retryAfterSeconds);
  }
}
