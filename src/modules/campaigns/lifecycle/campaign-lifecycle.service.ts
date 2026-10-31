import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import type { Actor } from '../../../common/auth/index.js';
import { DB, withTransaction } from '../../../infrastructure/database/index.js';
import { QueuePublisher } from '../../../infrastructure/queue/index.js';
import { AuditService } from '../../audit/index.js';
import { AccountsService, DeliveryLedger, messagingKeys, TemplatesService } from '../../messaging/index.js';
import type { Campaign, CampaignDocument, CampaignStatus } from '../campaign.schema.js';
import { CampaignInvalidError, CampaignNotFoundError, CampaignStateError } from '../campaigns.errors.js';
import { CampaignsRepository } from '../campaigns.repository.js';
import { CAMPAIGN_CONTROL_QUEUE, campaignCommand } from '../control/campaign-control.js';

/** Starting more than this many recipients needs the count typed back (`confirmTotal`). */
export const LARGE_AUDIENCE = 100_000;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Moves campaigns through their lifecycle (design.md#lifecycle). Every change is a conditional update on the
 * status (and version), recorded in the audit log in the same transaction. Pause and stop take effect through the
 * campaign's Redis state, which the sender and feeder read every second; heavy work (activating a start, test
 * sends) is queued.
 */
@Injectable()
export class CampaignLifecycleService {
  constructor(
    @InjectConnection(DB.messaging) private readonly connection: Connection,
    private readonly campaigns: CampaignsRepository,
    private readonly templates: TemplatesService,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
    private readonly publisher: QueuePublisher,
    private readonly redis: Redis,
    private readonly ledger: DeliveryLedger,
  ) {}

  async start(id: string, actor: Actor, confirmTotal?: number): Promise<CampaignDocument> {
    const current = await this.get(id);
    this.allow(current, ['ready', 'scheduled'], 'started');
    await this.preflight(current, confirmTotal);
    const started = await this.change(
      current,
      ['ready', 'scheduled'],
      actor,
      'campaign.start',
      { status: 'sending', sendStartedAt: new Date() },
      ['schedule'],
    );
    await this.publisher.publish(CAMPAIGN_CONTROL_QUEUE, campaignCommand, {
      campaignId: id,
      command: 'start',
    });
    return started;
  }

  async schedule(id: string, at: Date, actor: Actor, confirmTotal?: number): Promise<CampaignDocument> {
    const current = await this.get(id);
    this.allow(current, ['ready', 'scheduled'], 'scheduled');
    const ahead = at.getTime() - Date.now();
    if (ahead < 60_000 || ahead > MAX_SCHEDULE_AHEAD_MS) {
      throw new CampaignInvalidError(['Schedule the campaign between a minute and 30 days from now.']);
    }
    await this.preflight(current, confirmTotal);
    return this.change(current, ['ready', 'scheduled'], actor, 'campaign.schedule', {
      status: 'scheduled',
      schedule: { at },
    });
  }

  async unschedule(id: string, actor: Actor): Promise<CampaignDocument> {
    const current = await this.get(id);
    this.allow(current, ['scheduled'], 'unscheduled');
    return this.change(current, ['scheduled'], actor, 'campaign.unschedule', { status: 'ready' }, [
      'schedule',
    ]);
  }

  /** Takes effect within a second: the Redis state is set first, so a failure leaves the campaign paused. */
  async pause(id: string, actor: Actor): Promise<CampaignDocument> {
    const current = await this.get(id);
    this.allow(current, ['sending'], 'paused');
    await this.redis.set(messagingKeys.campaignState(id), 'paused');
    return this.change(current, ['sending'], actor, 'campaign.pause', {
      status: 'paused',
      pauseReason: `Paused by ${actor.user?.email ?? actor.service}`,
    });
  }

  /** Checks again, then re-activates: header media is refreshed and feeding continues from the first pending. */
  async resume(id: string, actor: Actor): Promise<CampaignDocument> {
    const current = await this.get(id);
    this.allow(current, ['paused'], 'resumed');
    await this.preflight(current, undefined, { skipSizeCheck: true });
    const resumed = await this.change(current, ['paused'], actor, 'campaign.resume', { status: 'sending' }, [
      'pauseReason',
    ]);
    await this.publisher.publish(CAMPAIGN_CONTROL_QUEUE, campaignCommand, {
      campaignId: id,
      command: 'start',
    });
    return resumed;
  }

  /** Nothing more is sent; the sweeper skips what's still pending once the queued sends are settled. */
  async stop(id: string, actor: Actor, reason?: string): Promise<CampaignDocument> {
    const current = await this.get(id);
    const from: CampaignStatus[] = ['building', 'ready', 'scheduled', 'sending', 'paused'];
    this.allow(current, from, 'stopped');
    await this.redis.set(messagingKeys.campaignState(id), 'stopped');
    return this.change(
      current,
      from,
      actor,
      'campaign.stop',
      {
        status: 'stopped',
        stoppedAt: new Date(),
        stopReason: reason ?? `Stopped by ${actor.user?.email ?? actor.service}`,
      },
      ['schedule'],
    );
  }

  /** Sends the real message to up to five numbers, through the direct-send queue. */
  async test(id: string, phones: readonly string[], actor: Actor): Promise<void> {
    const current = await this.get(id);
    this.allow(current, ['draft', 'ready', 'scheduled', 'paused'], 'tested');
    await this.audit.record({
      actor,
      action: 'campaign.test',
      entity: { type: 'campaign', id },
      after: { recipients: phones.length },
    });
    await this.publisher.publish(CAMPAIGN_CONTROL_QUEUE, campaignCommand, {
      campaignId: id,
      command: 'test',
      phones: [...phones],
    });
  }

  /**
   * Rebuilds a campaign's counters and ranks from the database (after Redis lost them), and re-activates it if it
   * is sending, so its Redis state and feed are back.
   */
  async reconcile(campaign: CampaignDocument): Promise<Record<string, number>> {
    const id = String(campaign._id);
    const counts = await this.ledger.rebuildCounters(id, campaign.totals?.total ?? 0);
    if (campaign.status === 'sending') {
      await this.publisher.publish(CAMPAIGN_CONTROL_QUEUE, campaignCommand, {
        campaignId: id,
        command: 'start',
      });
    }
    return counts;
  }

  /** What must hold before sending (design.md#lifecycle): template approved, account healthy, audience confirmed. */
  private async preflight(
    campaign: CampaignDocument,
    confirmTotal?: number,
    options: { skipSizeCheck?: boolean } = {},
  ): Promise<void> {
    const problems: string[] = [];
    const template = await this.templates.findById(campaign.template.templateId);
    if (template?.status !== 'APPROVED')
      problems.push(`The template is ${template?.status.toLowerCase() ?? 'missing'}, not approved.`);
    const account = await this.accounts.health();
    if (account.paused)
      problems.push(`The WhatsApp account is paused: ${account.pauseReason ?? 'see operations'}.`);
    if (account.marketingPaused && campaign.template.category === 'MARKETING') {
      problems.push('Marketing is paused on the number because of its quality rating.');
    }
    const total = campaign.totals?.total ?? 0;
    if (total === 0) problems.push('The audience is empty.');
    if (options.skipSizeCheck !== true && total > LARGE_AUDIENCE && confirmTotal !== total) {
      problems.push(
        `This campaign reaches ${total.toLocaleString('en-IN')} people: confirm by sending confirmTotal=${String(total)}.`,
      );
    }
    if (problems.length > 0) throw new CampaignInvalidError(problems);
  }

  private async change(
    current: CampaignDocument,
    from: readonly CampaignStatus[],
    actor: Actor,
    action: `campaign.${string}`,
    set: Partial<Campaign>,
    unset: (keyof Campaign)[] = [],
  ): Promise<CampaignDocument> {
    const id = String(current._id);
    return withTransaction(this.connection, async (session) => {
      const updated = await this.campaigns.transition(id, { from, version: current.version }, set, {
        unset,
        session,
      });
      if (updated === null)
        throw new CampaignStateError(id, current.status, action.split('.')[1] ?? 'changed');
      await this.audit.record(
        {
          actor,
          action,
          entity: { type: 'campaign', id },
          before: { status: current.status },
          after: { status: updated.status },
        },
        session,
      );
      return updated;
    });
  }

  private allow(campaign: CampaignDocument, from: readonly CampaignStatus[], action: string): void {
    if (!from.includes(campaign.status))
      throw new CampaignStateError(String(campaign._id), campaign.status, action);
  }

  private async get(id: string): Promise<CampaignDocument> {
    const campaign = await this.campaigns.findById(id);
    if (campaign === null) throw new CampaignNotFoundError(id);
    return campaign;
  }
}
