/**
 * How a delivery is named to Meta and in the wamid map (ADR-0015): `d:<deliveryId>` or, for a campaign delivery,
 * `d:<deliveryId>:<campaignId>`. Meta echoes it in every status webhook (`biz_opaque_callback_data`), so a status
 * finds its delivery and its campaign's counters without a database read.
 */
export function deliveryRef(deliveryId: string, campaignId?: string): string {
  return campaignId === undefined ? `d:${deliveryId}` : `d:${deliveryId}:${campaignId}`;
}

export interface DeliveryRef {
  readonly deliveryId: string;
  readonly campaignId?: string;
}

/** Reads `d:<deliveryId>[:<campaignId>]`, or the same without `d:` (the wamid map); `null` for anything else. */
export function parseDeliveryRef(value: string | undefined | null): DeliveryRef | null {
  if (value === undefined || value === null) return null;
  const match = /^(?:d:)?([\w-]{1,64})(?::([0-9a-f]{24}))?$/.exec(value);
  if (match?.[1] === undefined) return null;
  return match[2] === undefined ? { deliveryId: match[1] } : { deliveryId: match[1], campaignId: match[2] };
}
