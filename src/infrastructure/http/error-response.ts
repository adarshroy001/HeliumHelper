import { HttpException, HttpStatus } from '@nestjs/common';
import { AppError, type ErrorDetails } from '../../common/errors/index.js';

/** Every error response body (ADR-0008), before the filter adds `requestId`. */
export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: ErrorDetails;
}

const INTERNAL_ERROR: ErrorBody = {
  statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
  code: 'INTERNAL_ERROR',
  message: 'Something went wrong. Try again later.',
};

/**
 * Nest raises `HttpException`s itself: an unknown route, a body that isn't valid JSON, and so on. Their messages
 * can echo input or internals, so they are replaced with fixed ones.
 */
const NEST_ERRORS: Readonly<Partial<Record<number, readonly [code: string, message: string]>>> = {
  400: ['BAD_REQUEST', 'The request is invalid.'],
  401: ['UNAUTHORIZED', 'Authentication is required.'],
  403: ['FORBIDDEN', 'You are not allowed to do this.'],
  404: ['NOT_FOUND', 'The requested resource was not found.'],
  405: ['METHOD_NOT_ALLOWED', 'This method is not allowed here.'],
  409: ['CONFLICT', 'The request conflicts with the current state.'],
  413: ['PAYLOAD_TOO_LARGE', 'The request body is too large.'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'This content type is not supported.'],
  429: ['RATE_LIMITED', 'Too many requests. Try again later.'],
  // A failed readiness check (terminus).
  503: ['SERVICE_UNAVAILABLE', 'The service is not ready. Try again later.'],
};

/**
 * Maps anything thrown during a request to the error contract:
 * - an `AppError` keeps its status, code, message and details;
 * - a Nest `HttpException` in the 4xx range, or a 503, keeps its status with a fixed code and message;
 * - anything else is a 500 `INTERNAL_ERROR` that reveals nothing about the cause.
 */
export function toErrorBody(exception: unknown): ErrorBody {
  if (exception instanceof AppError) {
    const { status: statusCode, code, message, details } = exception;
    return details === undefined ? { statusCode, code, message } : { statusCode, code, message, details };
  }

  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    const known = NEST_ERRORS[statusCode];
    if (known) return { statusCode, code: known[0], message: known[1] };
    if (statusCode >= 400 && statusCode < 500) {
      return { statusCode, code: 'REQUEST_FAILED', message: 'The request could not be processed.' };
    }
  }

  return INTERNAL_ERROR;
}
