import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type { Actor } from '../../../common/auth/index.js';
import { QueuePublisher } from '../../../infrastructure/queue/index.js';
import { CampaignCounters, DeliveryLedger, messagingKeys } from '../../messaging/index.js';
import type { CampaignDocument } from '../campaign.schema.js';
import { CampaignInvalidError } from '../campaigns.errors.js';
import { CampaignsRepository } from '../campaigns.repository.js';
import { CAMPAIGN_CONTROL_QUEUE, campaignCommand } from '../control/campaign-control.js';
import { CampaignLifecycleService } from './campaign-lifecycle.service.js';

const CLOSE_AFTER_MS = 72 * 60 * 60 * 1000;
const STUCK_BUILD_MS = 5 * 60 * 1000;
const SWEEPER: Actor = { service: 'helium-backend:sweeper' };

/** Sends in flight, roughly: fed to the queue and without a result yet. For pacing; completion uses `resolved`. */
export function inFlight(counters: Readonly<Record<string, number>>): number {
  return (counters['fed'] ?? 0) - (counters['resolved'] ?? 0);
}

/**
 * Keeps campaigns moving without anyone watching (design.md#sweeper-every-minute): starts due schedules, records
 * pauses the messaging module asked for, completes and finalizes campaigns, closes old ones (clearing their Redis
 * state) and re-queues builds whose heartbeat stopped.
 */
@Injectable()
export class CampaignSweeper {
  constructor(
    private readonly campaigns: CampaignsRepository,
    private readonly lifecycle: CampaignLifecycleService,
    private readonly ledger: DeliveryLedger,
    private readonly counters: CampaignCounters,
    private readonly publisher: QueuePublisher,
    private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(CampaignSweeper.name);
  }

  async sweep(): Promise<void> {
    await this.startDue();
    const active = await this.campaigns.findByIds(await this.redis.smembers(messagingKeys.activeCampaigns()));
    for (const campaign of active) {
      await this.recordPauseRequest(campaign);
      await this.complete(campaign);
    }
    for (const campaign of await this.campaigns.findStoppedUnfinalized())
      await this.finalizeStopped(campaign);
    for (const campaign of await this.campaigns.findClosable(new Date(Date.now() - CLOSE_AFTER_MS)))
      await this.close(campaign);
    for (const campaign of await this.campaigns.findStuckBuilds(new Date(Date.now() - STUCK_BUILD_MS)))
      await this.requeueBuild(campaign);
  }

  /** Due schedules start like a manual start; if a check fails, the campaign is paused with the reason. */
  private async startDue(): Promise<void> {
    for (const campaign of await this.campaigns.findDue(new Date())) {
      const id = String(campaign._id);
      try {
        const started = await this.lifecycle.start(id, SWEEPER, campaign.totals?.total);
        this.logger.info({ campaignId: id, status: started.status }, 'scheduled campaign started');
      } catch (error) {
        if (!(error instanceof CampaignInvalidError)) throw error;
        const problems = (error.details?.['problems'] as string[] | undefined) ?? [];
        await this.campaigns.transition(
          id,
          { from: ['scheduled'] },
          { status: 'paused', pauseReason: `Not started at its scheduled time: ${problems.join(' ')}` },
          { unset: ['schedule'] },
        );
      }
    }
  }

  /** A pause the sender or an account event asked for (in Redis) becomes the campaign's status. */
  private async recordPauseRequest(campaign: CampaignDocument): Promise<void> {
    const id = String(campaign._id);
    const reason = await this.redis.get(messagingKeys.campaignPauseRequest(id));
    if (reason === null) return;
    if (campaign.status === 'sending') {
      await this.campaigns.transition(id, { from: ['sending'] }, { status: 'paused', pauseReason: reason });
      this.logger.warn({ campaignId: id, reason }, 'campaign paused automatically');
    }
    await this.redis.del(messagingKeys.campaignPauseRequest(id));
  }

  /** Done when everything was fed and every delivery has a result. */
  private async complete(campaign: CampaignDocument): Promise<void> {
    if (campaign.status !== 'sending') return;
    const id = String(campaign._id);
    const exhausted = await this.redis.hget(messagingKeys.feedCursor(id), 'exhausted');
    const resolved = (await this.counters.read(id))['resolved'] ?? 0;
    if (exhausted !== '1' || resolved < (campaign.totals?.total ?? 0)) return;
    await this.campaigns.transition(
      id,
      { from: ['sending'] },
      { status: 'send_complete', sendCompletedAt: new Date() },
    );
    await this.redis.srem(messagingKeys.activeCampaigns(), id);
    this.logger.info({ campaignId: id }, 'campaign complete');
  }

  /**
   * Skips a stopped campaign's never-sent deliveries, each through the counters script, so a delivery the sender is
   * skipping at the same moment is counted once. Repeated each sweep until none is left pending.
   */
  private async finalizeStopped(campaign: CampaignDocument): Promise<void> {
    const id = String(campaign._id);
    await this.ledger.skipRemaining(id, 'stopped');
    if ((await this.ledger.countPending(id)) > 0) return;
    await this.redis.srem(messagingKeys.activeCampaigns(), id);
    await this.campaigns.transition(id, { from: ['stopped'] }, { finalizedAt: new Date() });
  }

  /** Keeps the final counts on the campaign, then removes its Redis state. */
  private async close(campaign: CampaignDocument): Promise<void> {
    const id = String(campaign._id);
    const counts = await this.counters.read(id);
    const closed = await this.campaigns.transition(
      id,
      { from: ['send_complete', 'stopped'] },
      { status: 'closed', closedAt: new Date(), countsSnapshot: counts },
    );
    if (closed === null) return;
    await this.redis
      .multi()
      .del(
        messagingKeys.counters(id),
        messagingKeys.ranks(id),
        messagingKeys.billed(id),
        messagingKeys.buttons(id),
        messagingKeys.votes(id),
        messagingKeys.optOuts(id),
        messagingKeys.feedCursor(id),
        messagingKeys.campaignState(id),
        messagingKeys.campaignPauseRequest(id),
        messagingKeys.campaignWaiting(id),
        messagingKeys.autoReply(id),
      )
      .srem(messagingKeys.templateCampaigns(campaign.template.name, campaign.template.language), id)
      .srem(messagingKeys.activeCampaigns(), id)
      .exec();
    this.logger.info({ campaignId: id }, 'campaign closed');
  }

  private async requeueBuild(campaign: CampaignDocument): Promise<void> {
    const id = String(campaign._id);
    await this.campaigns.heartbeat(id, campaign.build?.processed ?? 0);
    await this.publisher.publish(CAMPAIGN_CONTROL_QUEUE, campaignCommand, {
      command: 'build',
      campaignId: id,
    });
    this.logger.warn({ campaignId: id }, 'stuck build re-queued');
  }
}
