import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisKey } from '../../../infrastructure/redis/index.js';
import { DeliveryLedger, normalizePhone } from '../../messaging/index.js';
import { AudienceSourcesRepository } from '../audience/audience-sources.repository.js';
import type { CampaignDocument } from '../campaign.schema.js';

const CACHE_SECONDS = 10 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 1000;

export interface Attribution {
  readonly windowDays: number;
  readonly orders: number;
  readonly buyers: number;
  readonly revenue: number;
  readonly computedAt: string;
}

/**
 * Orders placed by a campaign's recipients within its attribution window (default 7 days) after their message was
 * delivered. Reads the orders placed while the window could apply (from the start to the last possible day), and
 * matches them to delivered recipients in batches. Cached for 10 minutes.
 */
@Injectable()
export class CampaignAttributionService {
  constructor(
    private readonly sources: AudienceSourcesRepository,
    private readonly ledger: DeliveryLedger,
    private readonly redis: Redis,
  ) {}

  async attribution(campaign: CampaignDocument): Promise<Attribution | null> {
    if (campaign.sendStartedAt === undefined) return null;
    const id = String(campaign._id);
    const cacheKey = redisKey('campaign', 'attribution', id);
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) return JSON.parse(cached) as Attribution;

    const days = campaign.options.attributionDays;
    const windowMs = days * DAY_MS;
    const until = new Date(
      Math.min(
        Date.now(),
        (campaign.sendCompletedAt ?? campaign.stoppedAt ?? new Date()).getTime() + windowMs,
      ),
    );
    let orders = 0;
    let revenue = 0;
    const buyers = new Set<string>();
    let batch: { phone: string; at: Date; amount: number }[] = [];

    const settle = async () => {
      const delivered = await this.ledger.deliveredAt(id, [...new Set(batch.map((o) => o.phone))]);
      for (const order of batch) {
        const at = delivered.get(order.phone);
        if (at === undefined || order.at < at || order.at.getTime() > at.getTime() + windowMs) continue;
        orders += 1;
        revenue += order.amount;
        buyers.add(order.phone);
      }
      batch = [];
    };
    for await (const order of this.sources.ordersBetween(campaign.sendStartedAt, until)) {
      const phone = normalizePhone(typeof order.phone === 'string' ? order.phone : null);
      if (phone === null) continue;
      batch.push({ phone, at: order.createdAt, amount: order.amount });
      if (batch.length >= BATCH) await settle();
    }
    await settle();

    const result: Attribution = {
      windowDays: days,
      orders,
      buyers: buyers.size,
      revenue: Math.round(revenue * 100) / 100,
      computedAt: new Date().toISOString(),
    };
    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_SECONDS);
    return result;
  }
}
