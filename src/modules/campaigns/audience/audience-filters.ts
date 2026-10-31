import type { AudienceSource } from '../campaigns.schemas.js';

/**
 * MongoDB filters for the audience sources in the main database, ported from HeliumAdmin's
 * `src/lib/whatsapp/audience.ts` field for field, so a campaign reaches the same people. Dates are India days.
 */

type Filter = Record<string, unknown>;
type Filters<T extends AudienceSource['type']> = Extract<AudienceSource, { type: T }>['filters'];

const IST_OFFSET_MS = 330 * 60 * 1000;

/** The start or end of a day in India, as a UTC instant: `2026-10-31` → 2026-10-30T18:30:00Z. */
export function istDay(ymd: string, end: boolean): Date {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const utc = end ? Date.UTC(y, m - 1, d, 23, 59, 59, 999) : Date.UTC(y, m - 1, d);
  return new Date(utc - IST_OFFSET_MS);
}

function range(from?: string, to?: string): { $gte?: Date; $lte?: Date } | undefined {
  if (from === undefined && to === undefined) return undefined;
  return {
    ...(from === undefined ? {} : { $gte: istDay(from, false) }),
    ...(to === undefined ? {} : { $lte: istDay(to, true) }),
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function usersFilter(f: Filters<'users'>): Filter {
  const created = range(f.registeredFrom, f.registeredTo);
  return created === undefined ? {} : { createdAt: created };
}

export function ordersFilter(f: Filters<'orders'>): Filter {
  const filter: Filter = {};
  const created = range(f.orderDateFrom, f.orderDateTo);
  if (created !== undefined) filter['createdAt'] = created;
  if (f.status?.length) filter['status'] = { $in: f.status };
  if (f.paymentStatus?.length) filter['payment.status'] = { $in: f.paymentStatus };
  if (f.paymentMethod?.length) filter['payment.method'] = { $in: f.paymentMethod };
  if (f.channel?.length) filter['channel'] = { $in: f.channel };
  if (f.productModel?.length) filter['product.model'] = { $in: f.productModel };
  if (f.deliveryPartner?.length) filter['deliveryPartner'] = { $in: f.deliveryPartner };
  const amount = {
    ...(f.minOrderValue === undefined ? {} : { $gte: f.minOrderValue }),
    ...(f.maxOrderValue === undefined ? {} : { $lte: f.maxOrderValue }),
  };
  if (Object.keys(amount).length > 0) {
    filter['$or'] = [
      { sellingPrice: amount },
      { 'product.totalPrice': amount },
      { 'payment.amount': amount },
    ];
  }
  return filter;
}

/** Carts that didn't convert (unless asked), with a phone. */
export function cartsFilter(f: Filters<'abandoned_carts'>): Filter {
  const filter: Filter = { 'customer.phone': { $exists: true, $nin: [null, ''] } };
  if (f.includeRecovered !== true) filter['status'] = { $ne: 'converted' };
  const created = range(f.cartDateFrom, f.cartDateTo);
  if (created !== undefined) filter['createdAt'] = created;
  if (f.minCartValue !== undefined) filter['cart.total'] = { $gte: f.minCartValue };
  if (f.productTitle?.trim()) filter['cart.title'] = new RegExp(escapeRegex(f.productTitle.trim()), 'i');
  if (f.utmSource?.length) filter['utm.source'] = { $in: f.utmSource };
  return filter;
}

export function waitlistFilter(f: Filters<'waitlist'>): Filter {
  const filter: Filter = { phone: { $exists: true, $nin: [null, ''] } };
  const joined = range(f.joinedFrom, f.joinedTo);
  if (joined !== undefined) filter['joinedAt'] = joined;
  if (f.source?.length) filter['source'] = { $in: f.source };
  return filter;
}
