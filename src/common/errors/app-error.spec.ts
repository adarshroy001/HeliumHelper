import { describe, expect, it } from 'vitest';
import { AppError, NotFoundError, RateLimitedError, ValidationError } from './index.js';

class ThingNotFoundError extends NotFoundError {
  constructor(thingId: string, cause?: unknown) {
    super('THING_NOT_FOUND', 'Thing not found.', { details: { thingId }, cause });
  }
}

describe('AppError', () => {
  it('carries code, status, message and details, and is a real Error', () => {
    const err = new ThingNotFoundError('t1');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      name: 'ThingNotFoundError',
      code: 'THING_NOT_FOUND',
      status: 404,
      message: 'Thing not found.',
      details: { thingId: 't1' },
      retryable: false,
    });
    expect(err.stack).toContain('ThingNotFoundError');
  });

  it('keeps the original error as cause, and sets none when not given', () => {
    const original = new Error('connection reset');

    expect(new ThingNotFoundError('t1', original).cause).toBe(original);
    expect('cause' in new ThingNotFoundError('t1')).toBe(false);
  });

  it('builds validation errors with per-field details', () => {
    expect(new ValidationError({ 'body.name': 'Required' })).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'The request is invalid.',
      details: { fields: { 'body.name': 'Required' } },
    });
  });

  it('builds retryable rate-limit errors with the wait time', () => {
    expect(new RateLimitedError(30)).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 30 },
      retryable: true,
    });
  });
});
