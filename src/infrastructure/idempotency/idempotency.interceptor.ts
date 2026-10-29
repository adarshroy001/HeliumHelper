import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  type RawBodyRequest,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { catchError, from, mergeMap, type Observable, of, throwError } from 'rxjs';
import { getRequestActor } from '../../common/auth/index.js';
import { ValidationError } from '../../common/errors/index.js';
import { redisKey } from '../redis/keys.js';
import {
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
  IdempotencyUnavailableError,
} from './idempotency.errors.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const SAFE_KEY = /^[\w.:-]{1,128}$/;

/** A finished request's response is kept this long. */
const DONE_TTL_MS = 24 * 60 * 60 * 1000;
/** A request that crashed mid-way stops blocking its key after this long. */
const RUNNING_TTL_MS = 5 * 60 * 1000;

type Entry =
  { state: 'running'; fingerprint: string } | { state: 'done'; fingerprint: string; body: unknown };

/**
 * Makes a mutating route safe to retry (R10), with the `Idempotency-Key` header:
 * - the first request runs, and its response is kept for 24 hours;
 * - a retry with the same key and the same request gets that response again, without running the handler
 *   (`Idempotent-Replayed: true`);
 * - the same key with a different request is 422 `IDEMPOTENCY_KEY_REUSED`;
 * - a retry while the first is still running is 409 `IDEMPOTENCY_IN_PROGRESS`.
 *
 * Keys are scoped to the calling service. A request without the header runs normally. A failed request keeps
 * nothing, so it can be retried. If Redis is down, requests that carry a key are refused with 503: running
 * them could run them twice.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: Redis) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<RawBodyRequest<IncomingMessage>>();
    const header = req.headers[IDEMPOTENCY_HEADER];
    if (header === undefined) return next.handle();
    if (typeof header !== 'string' || !SAFE_KEY.test(header)) {
      throw new ValidationError({
        'Idempotency-Key': 'Must be 1 to 128 letters, digits or the characters - _ . :',
      });
    }

    const scope = getRequestActor(req)?.service ?? 'public';
    const key = redisKey('idempotency', 'request', `${scope}:${header}`);
    const fingerprint = createHash('sha256')
      .update(`${req.method ?? ''} ${req.url ?? ''}\n`)
      .update(req.rawBody ?? '')
      .digest('hex');

    const existing = await this.claim(key, fingerprint);
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyKeyReusedError();
      if (existing.state === 'running') throw new IdempotencyInProgressError();
      context.switchToHttp().getResponse<ServerResponse>().setHeader('Idempotent-Replayed', 'true');
      return of(existing.body);
    }

    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        const done: Entry = { state: 'done', fingerprint, body };
        // If this write fails, the running entry expires after RUNNING_TTL_MS and a retry then runs again.
        await this.redis.set(key, JSON.stringify(done), 'PX', DONE_TTL_MS).catch(() => undefined);
        return body;
      }),
      catchError((err: unknown) =>
        from(this.redis.del(key).catch(() => 0)).pipe(mergeMap(() => throwError(() => err))),
      ),
    );
  }

  /** Marks the key as running and returns `null`, or returns what an earlier request left there. */
  private async claim(key: string, fingerprint: string): Promise<Entry | null> {
    const running: Entry = { state: 'running', fingerprint };
    let stored: string | null;
    try {
      const claimed = await this.redis.set(key, JSON.stringify(running), 'PX', RUNNING_TTL_MS, 'NX');
      if (claimed === 'OK') return null;
      stored = await this.redis.get(key);
    } catch (err) {
      throw new IdempotencyUnavailableError(err);
    }
    // The entry expired between the two calls: the key is free again.
    return stored === null ? this.claim(key, fingerprint) : (JSON.parse(stored) as Entry);
  }
}
