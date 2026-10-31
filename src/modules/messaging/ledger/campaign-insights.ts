import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { InboundMessagesRepository } from '../data/messaging.repositories.js';
import { keys } from '../messaging.keys.js';

/** What the campaigns module reads about a campaign's replies: poll tallies and the replies themselves. */
@Injectable()
export class CampaignInsights {
  constructor(
    private readonly redis: Redis,
    private readonly inbound: InboundMessagesRepository,
  ) {}

  /** Votes per button: one per recipient, their first tap. Kept until the campaign closes. */
  async buttonTallies(campaignId: string): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(keys.buttons(campaignId));
    return Object.fromEntries(Object.entries(raw).map(([button, n]) => [button, Number(n)]));
  }

  /** Why the feeder is holding a sending campaign back, if it is. */
  waitingReason(campaignId: string): Promise<string | null> {
    return this.redis.get(keys.campaignWaiting(campaignId));
  }

  replies(campaignId: string, before: Date | undefined, limit: number) {
    return this.inbound.campaignReplies(campaignId, before, limit);
  }
}
