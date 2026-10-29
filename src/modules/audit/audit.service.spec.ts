import { describe, expect, it } from 'vitest';
import { changedFields } from './audit.service.js';

describe('changedFields', () => {
  it('keeps only fields whose values differ, comparing nested values deeply', () => {
    expect(
      changedFields(
        { status: 'draft', name: 'Sale', tags: ['a'], limits: { daily: 10 } },
        { status: 'running', name: 'Sale', tags: ['a'], limits: { daily: 20 } },
      ),
    ).toEqual({
      status: { from: 'draft', to: 'running' },
      limits: { from: { daily: 10 }, to: { daily: 20 } },
    });
  });

  it('records fields that appear or disappear', () => {
    expect(changedFields({ a: 1 }, { b: 2 })).toEqual({
      a: { from: 1, to: undefined },
      b: { from: undefined, to: 2 },
    });
    expect(changedFields(undefined, undefined)).toEqual({});
  });
});
