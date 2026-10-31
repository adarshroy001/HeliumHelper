import { z } from 'zod';
import type { DeliveryError } from '../data/delivery.schema.js';
import { type DeliveryRef, parseDeliveryRef } from './delivery-ref.js';

/** A status from Meta's webhook, read into what the status pipeline needs. */
export interface ParsedStatus {
  readonly wamid: string;
  readonly status: 'sent' | 'delivered' | 'read' | 'failed';
  readonly at: Date;
  /** From `biz_opaque_callback_data`, when Meta echoed ours. */
  readonly ref: DeliveryRef | null;
  readonly error?: DeliveryError;
  readonly pricing?: { readonly category?: string; readonly billable?: boolean };
  /** The raw status, kept when it can't be matched. */
  readonly raw: Readonly<Record<string, unknown>>;
}

// Third-party payload: unknown keys are kept (R5).
const statusSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  timestamp: z.string().regex(/^\d+$/),
  biz_opaque_callback_data: z.string().optional(),
  errors: z
    .array(
      z.looseObject({
        code: z.number().optional(),
        title: z.string().optional(),
        message: z.string().optional(),
        error_data: z.looseObject({ details: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  pricing: z.looseObject({ category: z.string().optional(), billable: z.boolean().optional() }).optional(),
});

const KNOWN = new Set(['sent', 'delivered', 'read', 'failed']);

/**
 * The statuses of one webhook change. Statuses we don't track (Meta's `deleted`, `warning`) and malformed entries
 * are dropped and counted in `ignored`.
 */
export function parseStatuses(value: Readonly<Record<string, unknown>>): {
  statuses: ParsedStatus[];
  ignored: number;
} {
  const list = Array.isArray(value['statuses']) ? (value['statuses'] as unknown[]) : [];
  const statuses: ParsedStatus[] = [];
  for (const item of list) {
    const parsed = statusSchema.safeParse(item);
    if (!parsed.success || !KNOWN.has(parsed.data.status)) continue;
    const { id, status, timestamp, errors, pricing } = parsed.data;
    const at = new Date(Number(timestamp) * 1000);
    const first = errors?.[0];
    statuses.push({
      wamid: id,
      status: status as ParsedStatus['status'],
      at,
      ref: parseDeliveryRef(parsed.data.biz_opaque_callback_data),
      ...(status === 'failed'
        ? {
            error: {
              ...(first?.code === undefined ? {} : { code: first.code }),
              title: (first?.error_data?.details ?? first?.title ?? first?.message ?? 'failed').slice(0, 500),
              at,
            },
          }
        : {}),
      ...(pricing === undefined
        ? {}
        : {
            pricing: {
              ...(pricing.category === undefined ? {} : { category: pricing.category }),
              ...(pricing.billable === undefined ? {} : { billable: pricing.billable }),
            },
          }),
      raw: parsed.data,
    });
  }
  return { statuses, ignored: list.length - statuses.length };
}
