import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { QueuePublisher } from '../../../infrastructure/queue/index.js';
import {
  buildTemplatePayload,
  DeliveryLedger,
  deliverySend,
  extractTemplateVariables,
  MAIN_ACCOUNT_ID,
  MediaService,
  messagingKeys,
  normalizePhone,
  resolveParams,
  WA_SEND_P1_QUEUE,
} from '../../messaging/index.js';
import type { CampaignDocument } from '../campaign.schema.js';
import { CampaignsRepository } from '../campaigns.repository.js';

/**
 * The background half of starting (and resuming) a campaign, and of test sends: the steps that call Meta or touch
 * many keys, so the API answers at once.
 */
@Injectable()
export class CampaignActivationService {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly campaigns: CampaignsRepository,
    private readonly media: MediaService,
    private readonly ledger: DeliveryLedger,
    private readonly publisher: QueuePublisher,
    private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(CampaignActivationService.name);
  }

  /**
   * Makes a `sending` campaign live: header media on Meta (fresh), the endpoint chosen, and its Redis state
   * published for the sender, the feeder and the inbound consumer. Feeding restarts from the first pending.
   */
  async activate(campaign: CampaignDocument): Promise<void> {
    const id = String(campaign._id);
    let header: Record<string, unknown> | undefined;
    try {
      header = await this.headerComponent(campaign);
    } catch (error) {
      this.logger.warn({ campaignId: id, err: error }, 'header media upload failed');
      await this.redis.set(messagingKeys.campaignState(id), 'paused');
      await this.campaigns.transition(
        id,
        { from: ['sending'] },
        {
          status: 'paused',
          pauseReason: 'The header media could not be uploaded to WhatsApp. Resume to try again.',
        },
      );
      return;
    }
    const endpoint =
      campaign.template.category === 'MARKETING' ? this.config.account.marketingEndpoint : 'messages';
    await this.campaigns.transition(
      id,
      { from: ['sending'] },
      {
        send: {
          endpoint,
          phoneNumberId: this.config.account.phoneNumberId,
          template: {
            name: campaign.template.name,
            language: { code: campaign.template.language },
            ...(header === undefined ? {} : { components: [header] }),
          },
        },
      },
    );

    const live = this.redis
      .multi()
      .set(messagingKeys.campaignState(id), 'sending')
      // Feeding restarts from the first pending delivery.
      .del(messagingKeys.feedCursor(id))
      .hset(messagingKeys.feedCursor(id), 'cursor', '-1')
      .hsetnx(messagingKeys.counters(id), 'total', String(campaign.totals?.total ?? 0))
      .sadd(messagingKeys.templateCampaigns(campaign.template.name, campaign.template.language), id)
      .sadd(messagingKeys.activeCampaigns(), id);
    const rule = campaign.autoReply;
    if (rule?.enabled === true) {
      live.set(
        messagingKeys.autoReply(id),
        JSON.stringify({
          trigger: rule.trigger,
          mode: rule.mode,
          ...(rule.text === undefined ? {} : { text: rule.text }),
          ...(rule.template === undefined ? {} : { template: rule.template }),
          ...(rule.choiceReplies === undefined ? {} : { choiceReplies: rule.choiceReplies }),
        }),
      );
    }
    await live.exec();
    this.logger.info({ campaignId: id, endpoint }, 'campaign live');
  }

  /** Sends the campaign's message to a few numbers, with sample values, through the direct-send queue. */
  async sendTest(campaign: CampaignDocument, phones: readonly string[]): Promise<void> {
    const header = await this.headerComponent(campaign);
    const variables = extractTemplateVariables(campaign.template.components);
    const messages = phones.flatMap((raw) => {
      const to = normalizePhone(raw);
      if (to === null) return [];
      const params = resolveParams(variables, campaign.variableMapping, { phone: to });
      const template = buildTemplatePayload({
        name: campaign.template.name,
        language: campaign.template.language,
        params,
      });
      const components = [...(header === undefined ? [] : [header]), ...(template.components ?? [])];
      return [
        {
          to,
          payload: {
            kind: 'template' as const,
            template: { ...template, ...(components.length > 0 ? { components } : {}) },
          },
        },
      ];
    });
    const ids = await this.ledger.addMessages('test', String(campaign._id), messages);
    const endpoint =
      campaign.template.category === 'MARKETING' ? this.config.account.marketingEndpoint : 'messages';
    await this.publisher.publishBatch(
      WA_SEND_P1_QUEUE,
      deliverySend,
      messages.map((m, i) => ({
        data: {
          deliveryId: ids[i] ?? '',
          accountId: MAIN_ACCOUNT_ID,
          phoneNumberId: this.config.account.phoneNumberId,
          to: m.to,
          endpoint,
          payload: m.payload,
          businessInitiated: true,
        },
      })),
    );
  }

  /** The header component with the media's (fresh) Meta ID, when the template has a media header. */
  private async headerComponent(campaign: CampaignDocument): Promise<Record<string, unknown> | undefined> {
    if (campaign.headerMedia === undefined) return undefined;
    const { type, mediaId } = campaign.headerMedia;
    const metaId = await this.media.ensureOnMeta(mediaId);
    return { type: 'header', parameters: [{ type, [type]: { id: metaId } }] };
  }
}
