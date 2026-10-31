import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { DeliveriesRepository, type StatusUpdate } from '../data/deliveries.repository.js';
import { UnmatchedStatusesRepository } from '../data/messaging.repositories.js';
import { keys } from '../messaging.keys.js';
import { CampaignCounters } from '../sending/campaign-counters.js';
import { type DeliveryRef, parseDeliveryRef } from './delivery-ref.js';
import type { ParsedStatus } from './status-parser.js';

/** Statuses applied per round trip, and the longest a status waits for its batch. */
const MAX_BATCH = 1000;
const MAX_WAIT_MS = 500;

interface Matched {
  readonly status: ParsedStatus;
  readonly ref: DeliveryRef;
}

interface Pending {
  readonly items: readonly Matched[];
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * Applies Meta's delivery statuses (design.md#statuses): finds each status's delivery without a database read
 * when it can (callback data, then the wamid map), moves the campaign counters once per state with the
 * `transition` script, and writes everything in one `bulkWrite` per batch, guarded by rank.
 */
@Injectable()
export class StatusService implements OnModuleDestroy {
  private pending: Pending[] = [];
  private pendingCount = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly redis: Redis,
    private readonly deliveries: DeliveriesRepository,
    private readonly unmatched: UnmatchedStatusesRepository,
    private readonly counters: CampaignCounters,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(StatusService.name);
  }

  /** Splits statuses into those whose delivery is known and those that aren't (yet). */
  async correlate(
    statuses: readonly ParsedStatus[],
  ): Promise<{ matched: Matched[]; unmatched: ParsedStatus[] }> {
    const matched: Matched[] = [];
    const lookups = statuses.filter((s) => s.ref === null);
    for (const status of statuses) if (status.ref !== null) matched.push({ status, ref: status.ref });
    if (lookups.length === 0) return { matched, unmatched: [] };

    const mapped = await this.redis.mget(lookups.map((s) => keys.wamid(s.wamid)));
    const unmatched: ParsedStatus[] = [];
    for (const [i, status] of lookups.entries()) {
      const ref = parseDeliveryRef(mapped[i]) ?? (await this.deliveries.findByWamid(status.wamid));
      if (ref === null) unmatched.push(status);
      else matched.push({ status, ref });
    }
    return { matched, unmatched };
  }

  /** Resolves once the statuses are written; rejects if the write failed (the message is retried). */
  apply(items: readonly Matched[]): Promise<void> {
    if (items.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.pending.push({ items, resolve, reject });
      this.pendingCount += items.length;
      if (this.pendingCount >= MAX_BATCH) void this.flush();
      else this.timer ??= setTimeout(() => void this.flush(), MAX_WAIT_MS);
    });
  }

  /** Records statuses that never matched a delivery (old v1 or storefront messages); they expire after 7 days. */
  async recordUnmatched(statuses: readonly ParsedStatus[], phoneNumberId: string | undefined): Promise<void> {
    await this.unmatched.insertMany(
      statuses.map((s) => ({
        wamid: s.wamid,
        ...(phoneNumberId === undefined ? {} : { phoneNumberId }),
        status: s.raw,
        receivedAt: new Date(),
      })),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = [];
    this.pendingCount = 0;
    if (batch.length === 0) return;
    const items = batch.flatMap((p) => p.items);

    try {
      await this.countCampaigns(items);
      const updates: StatusUpdate[] = items.map(({ status, ref }) => ({
        id: ref.deliveryId,
        status: status.status,
        at: status.at,
        wamid: status.wamid,
        ...(status.error === undefined ? {} : { error: status.error }),
        ...(status.pricing === undefined ? {} : { pricing: status.pricing }),
      }));
      await this.deliveries.applyStatuses(updates);
      await this.settleClaims(items);
    } catch (error) {
      for (const p of batch) p.reject(error);
      return;
    }
    for (const p of batch) p.resolve();
  }

  /** Counters first: if the database write then fails, the retry finds the counters already moved. */
  private async countCampaigns(items: readonly Matched[]): Promise<void> {
    const campaignItems = items.filter((item) => item.ref.campaignId !== undefined);
    const applied = await this.counters.apply(
      campaignItems.map(({ status, ref }) => ({
        campaignId: ref.campaignId ?? '',
        deliveryId: ref.deliveryId,
        status: status.status,
      })),
    );
    // Billable messages per pricing category, counted once per delivery: by the status that first took it to
    // `sent` or beyond.
    const billable = campaignItems.filter(({ status }, i) => {
      const result = applied[i];
      return (
        result?.applied === true &&
        result.previous < 2 &&
        status.status !== 'failed' &&
        status.pricing?.billable === true
      );
    });
    await Promise.all(
      billable.map(({ status, ref }) =>
        this.counters.increment(ref.campaignId ?? '', `billable:${status.pricing?.category ?? 'unknown'}`),
      ),
    );
  }

  /** A status proves the send happened: the claim is confirmed and the delivery leaves the unconfirmed list. */
  private async settleClaims(items: readonly Matched[]): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const { status, ref } of items) {
      pipeline.zrem(keys.unconfirmed(), ref.deliveryId);
      pipeline.set(keys.claim(ref.deliveryId), `ok:${status.wamid}`, 'KEEPTTL', 'XX');
    }
    await pipeline.exec();
  }
}
