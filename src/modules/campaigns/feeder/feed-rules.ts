import type { Redis } from 'ioredis';
import { MAIN_ACCOUNT_ID, messagingKeys } from '../../messaging/index.js';
import type { CampaignDocument } from '../campaign.schema.js';

/** Minutes since midnight in India. */
export function indiaMinutes(at: Date): number {
  return (at.getUTCHours() * 60 + at.getUTCMinutes() + 330) % 1440;
}

/** Whether `at` falls inside a daily window such as 10:00–21:00 (or an overnight one such as 20:00–02:00), India time. */
export function insideWindow(window: { start: string; end: string }, at: Date): boolean {
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number) as [number, number];
    return h * 60 + m;
  };
  const now = indiaMinutes(at);
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** The hourly keys of the last 24 hours, as the sender writes them (`yyyyMMddHH`, UTC). */
export function lastDayHours(at: Date): string[] {
  return Array.from({ length: 24 }, (_, i) =>
    new Date(at.getTime() - i * 3_600_000).toISOString().slice(0, 13).replace(/\D/g, ''),
  );
}

/** Share of the daily messaging limit at which marketing stops being fed. */
const LIMIT_SHARE = 0.95;

/**
 * Why a sending campaign must not be fed right now, or `null` to feed it: outside its send window, marketing
 * paused on the account (phone quality), or the business portfolio near its daily messaging limit.
 */
export async function holdReason(
  campaign: CampaignDocument,
  at: Date,
  redis: Redis,
  portfolioId: string,
): Promise<string | null> {
  const window = campaign.options.sendWindow;
  if (window !== undefined && !insideWindow(window, at))
    return `Outside its send window (${window.start}–${window.end} IST)`;
  if (campaign.template.category !== 'MARKETING') return null;
  if ((await redis.get(messagingKeys.marketingPaused(MAIN_ACCOUNT_ID))) !== null)
    return 'Marketing paused on the number (quality)';
  const limit = Number(await redis.get(messagingKeys.messagingLimit(portfolioId)));
  if (limit > 0) {
    const used = await redis.pfcount(
      ...lastDayHours(at).map((hour) => messagingKeys.uniqueUsers(portfolioId, hour)),
    );
    if (used >= limit * LIMIT_SHARE) return 'Waiting for the daily messaging limit';
  }
  return null;
}
