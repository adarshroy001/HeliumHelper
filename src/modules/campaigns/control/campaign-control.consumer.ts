import { PinoLogger } from 'nestjs-pino';
import { AppError } from '../../../common/errors/index.js';
import { ack, Consumer, type MessageHandler, type Outcome } from '../../../infrastructure/queue/index.js';
import { AudienceBuilder } from '../audience/audience-builder.js';
import type { CampaignDocument } from '../campaign.schema.js';
import { CampaignsRepository } from '../campaigns.repository.js';
import { CampaignActivationService } from '../lifecycle/campaign-activation.service.js';
import { CampaignSweeper } from '../lifecycle/campaign-sweeper.service.js';
import { CAMPAIGN_CONTROL_QUEUE, campaignCommand, type CampaignCommand } from './campaign-control.js';

const EMPTY = 'Nobody is left in the audience after exclusions, suppressions and the frequency cap.';

/** Runs heavy campaign commands. Builds can take minutes: the framework keeps the message hidden meanwhile. */
@Consumer({ queue: CAMPAIGN_CONTROL_QUEUE, message: campaignCommand, concurrency: 4, visibilitySeconds: 300 })
export class CampaignControlConsumer implements MessageHandler<CampaignCommand> {
  constructor(
    private readonly campaigns: CampaignsRepository,
    private readonly builder: AudienceBuilder,
    private readonly activation: CampaignActivationService,
    private readonly sweeper: CampaignSweeper,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(CampaignControlConsumer.name);
  }

  async handle(command: CampaignCommand): Promise<Outcome> {
    if (command.command === 'sweep') {
      await this.sweeper.sweep();
      return ack();
    }
    const campaign = await this.campaigns.findById(command.campaignId);
    if (campaign === null) return ack();
    switch (command.command) {
      case 'build':
        await this.build(campaign);
        break;
      case 'start':
        // Paused or stopped meanwhile: nothing to activate.
        if (campaign.status === 'sending') await this.activation.activate(campaign);
        break;
      case 'test':
        await this.activation.sendTest(campaign, command.phones);
        break;
    }
    return ack();
  }

  private async build(campaign: CampaignDocument): Promise<void> {
    // Built already, or no longer wanted: nothing to do.
    if (campaign.status !== 'building') return;
    let totals;
    try {
      totals = await this.builder.build(campaign);
    } catch (error) {
      // A problem with the campaign's own inputs (a missing upload) won't fix itself: fail the build.
      if (error instanceof AppError && !error.retryable) {
        await this.fail(campaign, error.message);
        return;
      }
      throw error;
    }
    if (totals.total === 0) await this.fail(campaign, EMPTY, totals);
    else
      await this.campaigns.transition(
        String(campaign._id),
        { from: ['building'] },
        { status: 'ready', totals, builtAt: new Date() },
      );
  }

  private async fail(
    campaign: CampaignDocument,
    error: string,
    totals?: CampaignDocument['totals'],
  ): Promise<void> {
    this.logger.warn({ campaignId: String(campaign._id), error }, 'campaign build failed');
    await this.campaigns.transition(
      String(campaign._id),
      { from: ['building'] },
      {
        status: 'build_failed',
        build: { seq: campaign.build?.seq ?? 0, processed: campaign.build?.processed ?? 0, error },
        ...(totals === undefined ? {} : { totals }),
      },
    );
  }
}
