import { HttpStatus } from '@nestjs/common';
import { AppError, ConflictError } from '../../common/errors/index.js';

/** 422: the key was already used for a different request (another body, method or path). */
export class IdempotencyKeyReusedError extends AppError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
  }
}

/** 409: the first request with this key hasn't finished yet. Retry after a moment. */
export class IdempotencyInProgressError extends ConflictError {
  constructor() {
    super(
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed. Try again shortly.',
      { retryable: true },
    );
  }
}

/** 503: Redis is down, so a retry can't be recognised. Refusing is safer than running twice. */
export class IdempotencyUnavailableError extends AppError {
  readonly status = HttpStatus.SERVICE_UNAVAILABLE;

  constructor(cause: unknown) {
    super(
      'IDEMPOTENCY_UNAVAILABLE',
      'The request can not be processed safely right now. Try again shortly.',
      {
        cause,
        retryable: true,
      },
    );
  }
}
