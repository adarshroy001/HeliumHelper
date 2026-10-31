import { mongo } from 'mongoose';

/**
 * For an unordered insert that failed only on duplicate keys (11000), the input indexes that were duplicates;
 * `null` when the error is anything else, which the caller rethrows.
 */
export function duplicateKeyIndexes(error: unknown): number[] | null {
  if (!(error instanceof mongo.MongoBulkWriteError)) return null;
  const raw: unknown = error.writeErrors;
  const errors = (Array.isArray(raw) ? raw : [raw]) as { code?: unknown; index?: unknown }[];
  if (errors.some((e) => e.code !== 11000)) return null;
  return errors.map((e) => (typeof e.index === 'number' ? e.index : -1));
}
