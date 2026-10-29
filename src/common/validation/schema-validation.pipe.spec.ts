import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../errors/index.js';
import { issuesToFields, SchemaValidationPipe } from './schema-validation.pipe.js';

const schema = z.strictObject({
  name: z.string().min(1),
  items: z.array(z.strictObject({ phone: z.string() })),
});

const issuesFor = (value: unknown) => schema.safeParse(value).error?.issues ?? [];

describe('issuesToFields', () => {
  it('keys each problem by its path, with one entry per unknown key', () => {
    const fields = issuesToFields(issuesFor({ name: 5, items: [{ phone: 1 }], extra: 1, other: 2 }));

    expect(fields).toEqual({
      name: 'Invalid input: expected string, received number',
      'items.0.phone': 'Invalid input: expected string, received number',
      extra: 'Unknown field.',
      other: 'Unknown field.',
    });
  });

  it('names a single validated value after its property, or (root) without one', () => {
    const issues = z.uuid().safeParse('nope').error?.issues ?? [];

    expect(Object.keys(issuesToFields(issues, 'id'))).toEqual(['id']);
    expect(Object.keys(issuesToFields(issues))).toEqual(['(root)']);
  });
});

describe('SchemaValidationPipe', () => {
  const pipe = new SchemaValidationPipe();

  it('returns the parsed value', async () => {
    const coerced = z.strictObject({ n: z.string().transform(Number) });

    await expect(pipe.transform({ n: '7' }, { type: 'query', schema: coerced })).resolves.toEqual({ n: 7 });
  });

  it('throws VALIDATION_FAILED with per-field details', async () => {
    const result = pipe.transform({ name: '', items: [] }, { type: 'body', schema });

    await expect(result).rejects.toBeInstanceOf(ValidationError);
    await expect(result).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { name: expect.any(String) as unknown } },
    });
  });

  it('leaves parameters without a schema alone', async () => {
    const value = { anything: true };

    await expect(pipe.transform(value, { type: 'body' })).resolves.toBe(value);
  });
});
