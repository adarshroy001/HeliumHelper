import type { HttpStatus } from '@nestjs/common';

/** Structured, client-safe extra information about an error, e.g. `{ campaignId }`. */
export type ErrorDetails = Readonly<Record<string, unknown>>;

export interface AppErrorOptions {
  details?: ErrorDetails;
  /** Whether a worker should retry the job that failed with this error. Defaults to `false`. */
  retryable?: boolean;
  /** The original error. Logged for 5xx errors, never sent to the client. */
  cause?: unknown;
}

/**
 * Base of every expected failure (ADR-0008). Services and consumers throw subclasses of it, never
 * `HttpException` or a bare `Error`. The global exception filter turns it into
 * `{ statusCode, code, message, details?, requestId }`.
 *
 * - `code`: `SCREAMING_SNAKE_CASE`, stable, never reused (`CAMPAIGN_NOT_FOUND`).
 * - `message`: safe to show a user. It is sent to the client as is.
 */
export abstract class AppError extends Error {
  abstract readonly status: HttpStatus;
  readonly details: ErrorDetails | undefined;
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}
