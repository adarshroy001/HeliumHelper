import { HttpStatus } from '@nestjs/common';
import { AppError } from './app-error.js';

// Modules extend these in their own `*.errors.ts`, fixing the code and message:
//
//   export class CampaignNotFoundError extends NotFoundError {
//     constructor(campaignId: string) {
//       super('CAMPAIGN_NOT_FOUND', 'Campaign not found.', { details: { campaignId } });
//     }
//   }

/** 401: the caller is not authenticated. */
export class UnauthorizedError extends AppError {
  readonly status = HttpStatus.UNAUTHORIZED;
}

/** 403: the caller is authenticated but may not do this. */
export class ForbiddenError extends AppError {
  readonly status = HttpStatus.FORBIDDEN;
}

/** 404: the thing asked for doesn't exist (or the caller may not know it exists). */
export class NotFoundError extends AppError {
  readonly status = HttpStatus.NOT_FOUND;
}

/** 409: the request clashes with the current state, e.g. a duplicate or a wrong status. */
export class ConflictError extends AppError {
  readonly status = HttpStatus.CONFLICT;
}

/** 400 `VALIDATION_FAILED`. `fields` maps each input path to a message: `{ 'body.name': 'Required' }`. */
export class ValidationError extends AppError {
  readonly status = HttpStatus.BAD_REQUEST;

  constructor(fields: Readonly<Record<string, string>>, message = 'The request is invalid.') {
    super('VALIDATION_FAILED', message, { details: { fields } });
  }
}

/** 429 `RATE_LIMITED`. The caller may try again after `retryAfterSeconds`. */
export class RateLimitedError extends AppError {
  readonly status = HttpStatus.TOO_MANY_REQUESTS;

  constructor(retryAfterSeconds: number) {
    super('RATE_LIMITED', 'Too many requests. Try again later.', {
      details: { retryAfterSeconds },
      retryable: true,
    });
  }
}
