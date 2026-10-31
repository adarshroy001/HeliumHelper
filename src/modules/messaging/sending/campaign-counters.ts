import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { runScript } from '../../../infrastructure/redis/index.js';
import { keys } from '../messaging.keys.js';
import { transition } from './counters.scripts.js';

export type CountedStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped';

export interface CounterEvent {
  readonly campaignId: string;
  readonly deliveryId: string;
  readonly status: CountedStatus;
}

/**
 * Live campaign counters in Redis (`wa:cnt:{campaignId}`), moved by the `transition` script so each delivery
 * counts once per state whatever the duplicates. The database stays the record; counters can be rebuilt from it.
 */
@Injectable()
export class CampaignCounters {
  constructor(private readonly redis: Redis) {}

  /**
   * Applies events (sent together, without waiting between them). For each: whether it counted, and the rank the
   * delivery had before (0 pending, 1 accepted, 2 sent, 3 delivered, 4 read; below 0 failed or skipped).
   */
  async apply(events: readonly CounterEvent[]): Promise<{ applied: boolean; previous: number }[]> {
    const results = await Promise.all(
      events.map((event) =>
        runScript(
          this.redis,
          transition,
          [keys.ranks(event.campaignId), keys.counters(event.campaignId)],
          [event.deliveryId, event.status],
        ),
      ),
    );
    return results.map(([applied, previous]) => ({ applied: applied === 1, previous }));
  }

  /** Adds to plain counters, such as `fed`, `replied` or a pricing category. */
  async increment(campaignId: string, field: string, by = 1): Promise<void> {
    await this.redis.hincrby(keys.counters(campaignId), field, by);
  }

  async read(campaignId: string): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(keys.counters(campaignId));
    return Object.fromEntries(Object.entries(raw).map(([field, value]) => [field, Number(value)]));
  }
}
