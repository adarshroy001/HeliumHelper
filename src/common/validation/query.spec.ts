import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { paginationQuery, queryBoolean, queryCursor, queryInt } from './query.js';

describe('query helpers', () => {
  it('parses whole numbers and applies the given rules', () => {
    const limit = queryInt(z.number().int().min(1).max(100));

    expect(limit.parse('42')).toBe(42);
    expect(queryInt().parse('-3')).toBe(-3);
    expect(limit.safeParse('0').success).toBe(false);
    expect(limit.safeParse('101').success).toBe(false);
  });

  it('rejects text that is not exactly a whole number', () => {
    for (const bad of ['', ' ', 'abc', '1.5', '1e3', '0x10', '12abc', '9999999999999999']) {
      expect(queryInt().safeParse(bad).success, bad).toBe(false);
    }
  });

  it('parses only "true" and "false" as booleans', () => {
    expect(queryBoolean().parse('true')).toBe(true);
    expect(queryBoolean().parse('false')).toBe(false);
    for (const bad of ['', '1', 'yes', 'TRUE']) {
      expect(queryBoolean().safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts URL-safe cursors only', () => {
    expect(queryCursor().parse('eyJpZCI6IjEifQ')).toBe('eyJpZCI6IjEifQ');
    expect(queryCursor().safeParse('a b').success).toBe(false);
    expect(queryCursor().safeParse('').success).toBe(false);
  });

  it('defaults the page size and rejects unknown query keys', () => {
    expect(paginationQuery.parse({})).toEqual({ limit: 20 });
    expect(paginationQuery.parse({ limit: '5', cursor: 'abc' })).toEqual({ limit: 5, cursor: 'abc' });
    expect(paginationQuery.safeParse({ page: '2' }).success).toBe(false);
  });
});
