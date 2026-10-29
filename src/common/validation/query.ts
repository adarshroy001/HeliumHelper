import { z } from 'zod';

// Query string values always arrive as text. These helpers turn them into typed values and reject anything
// ambiguous: `z.coerce.number()` would accept '' as 0 and `z.coerce.boolean()` would read 'false' as true.

/**
 * A whole number. Pass the number rules to apply after parsing:
 * `queryInt(z.number().int().min(1).max(100)).default(20)`.
 */
export function queryInt(rules: z.ZodType<number, number> = z.number().int()) {
  return z
    .string()
    .regex(/^-?\d{1,15}$/, 'Must be a whole number.')
    .transform(Number)
    .pipe(rules);
}

/** `true` or `false`, exactly. */
export function queryBoolean() {
  return z.stringbool({
    truthy: ['true'],
    falsy: ['false'],
    case: 'sensitive',
    error: 'Must be true or false.',
  });
}

/** An opaque pagination cursor, as returned by a previous page. Only its shape is checked here. */
export function queryCursor() {
  return z.string().regex(/^[\w-]{1,512}$/, 'Must be a cursor returned by a previous page.');
}

/** Standard list query: `?limit=20&cursor=...`. Extend it with a list's own filters. */
export const paginationQuery = z.strictObject({
  limit: queryInt(z.number().int().min(1).max(100)).default(20),
  cursor: queryCursor().optional(),
});
