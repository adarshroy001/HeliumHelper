import { describe, expect, it } from 'vitest';
import { classifyMetaError, readMetaError, retryDelaySeconds } from './meta-errors.js';

describe('classifyMetaError', () => {
  it.each([1, 2, 4, 17, 80007, 131016, 133004])('%i is retryable', (code) => {
    expect(classifyMetaError(code)).toEqual({ class: 'retryable' });
  });

  it.each([130429, 131056, 131057])('%i is a rate limit', (code) => {
    expect(classifyMetaError(code)).toEqual({ class: 'rate_limited' });
  });

  it.each([130403, 131026, 131047, 131049, 131050, 132000, 132012, 132015, 132016])(
    '%i is permanent',
    (code) => {
      expect(classifyMetaError(code)).toEqual({ class: 'permanent' });
    },
  );

  it.each([0, 190, 368, 131031, 131042, 133010])('%i stops the account', (code) => {
    expect(classifyMetaError(code)).toEqual({ class: 'fatal', fatalScope: 'account' });
  });

  it.each([131048, 131064, 132001])('%i stops the campaign', (code) => {
    expect(classifyMetaError(code)).toEqual({ class: 'fatal', fatalScope: 'campaign' });
  });

  it('treats an unknown code as retryable and flags it', () => {
    expect(classifyMetaError(999999)).toEqual({ class: 'retryable', unknownCode: true });
  });

  it('treats a missing code as retryable', () => {
    expect(classifyMetaError(undefined)).toEqual({ class: 'retryable' });
  });
});

describe('readMetaError', () => {
  it('prefers the error details, then the message', () => {
    expect(
      readMetaError({
        error: { code: 131026, message: 'Message undeliverable', error_data: { details: 'Not on WhatsApp' } },
      }),
    ).toEqual({ code: 131026, detail: 'Not on WhatsApp' });
    expect(readMetaError({ error: { code: 190, message: 'Token expired' } })).toEqual({
      code: 190,
      detail: 'Token expired',
    });
  });

  it('copes with bodies that are not Meta errors', () => {
    expect(readMetaError(null)).toEqual({ code: undefined, detail: 'Unknown Meta API error' });
    expect(readMetaError({ error: { code: '5' } })).toEqual({
      code: undefined,
      detail: 'Unknown Meta API error',
    });
    expect(readMetaError({ error: { code: 4 } })).toEqual({ code: 4, detail: 'Meta error 4' });
  });
});

describe('retryDelaySeconds', () => {
  it('backs off 30 s, 2 m, 8 m, 30 m, 2 h, then stays at 2 h', () => {
    const middle = () => 0.5;
    expect([1, 2, 3, 4, 5, 6].map((count) => retryDelaySeconds(count, middle))).toEqual([
      30, 120, 480, 1800, 7200, 7200,
    ]);
  });

  it('adds up to 20% jitter either way', () => {
    expect(retryDelaySeconds(1, () => 0)).toBe(24);
    expect(retryDelaySeconds(1, () => 1)).toBe(36);
  });
});
