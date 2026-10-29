import { type Model, type QueryFilter, Types } from 'mongoose';
import { ValidationError } from '../../common/errors/index.js';

/** What a list endpoint asks for: `paginationQuery` from `src/common/validation` produces it. */
export interface PageRequest {
  limit: number;
  cursor?: string | undefined;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page; `null` on the last page. */
  nextCursor: string | null;
}

function encodeCursor(id: Types.ObjectId): string {
  return Buffer.from(id.toHexString(), 'hex').toString('base64url');
}

/** Any 12 bytes are a valid position, so only the length is checked. */
function decodeCursor(cursor: string): Types.ObjectId {
  const hex = Buffer.from(cursor, 'base64url').toString('hex');
  if (hex.length !== 24) {
    throw new ValidationError({ cursor: 'Must be a cursor returned by a previous page.' });
  }
  return new Types.ObjectId(hex);
}

/**
 * One page of `filter`'s matches, newest first by `_id`, as plain objects (`lean`). Never uses `skip`: the cursor
 * is the last `_id` seen, so a page costs the same however deep it is (ADR-0005). The filter's fields need an
 * index that ends with `_id`, for example `{ status: 1, _id: -1 }`.
 */
export async function findPage<T>(
  model: Model<T>,
  filter: QueryFilter<T>,
  { limit, cursor }: PageRequest,
): Promise<Page<T & { _id: Types.ObjectId }>> {
  const query = cursor === undefined ? filter : { $and: [filter, { _id: { $lt: decodeCursor(cursor) } }] };
  const rows = await model
    .find(query)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean<(T & { _id: Types.ObjectId })[]>();

  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last._id) : null };
}
