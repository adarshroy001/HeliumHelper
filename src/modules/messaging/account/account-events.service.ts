import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { AccountsService, MAIN_ACCOUNT_ID } from '../accounts.service.js';
import { AccountsRepository, TemplatesRepository } from '../data/messaging.repositories.js';
import { keys } from '../messaging.keys.js';
import type { WebhookChangeData } from '../messaging.messages.js';
import { CampaignSignals } from '../sending/campaign-signals.js';

/** Template statuses that stop a template from being sent. */
const BLOCKED_TEMPLATE = new Set(['PAUSED', 'DISABLED', 'REJECTED', 'PENDING_DELETION', 'DELETED']);
/** Phone quality events that stop marketing on the number, and those that allow it again. */
const QUALITY_BAD = new Set(['FLAGGED', 'DOWNGRADE']);
const QUALITY_OK = new Set(['UNFLAGGED', 'UPGRADE']);
/** Account events that stop all sending. */
const ACCOUNT_BLOCKED = /RESTRICT|VIOLATION|BAN|DISABLE|DELETED/;

// Third-party payloads: unknown keys are kept (R5).
const templateStatus = z.looseObject({
  event: z.string(),
  message_template_id: z.union([z.number(), z.string()]),
  message_template_name: z.string().optional(),
  message_template_language: z.string().optional(),
  reason: z.string().nullish(),
});
const templateQuality = z.looseObject({
  message_template_id: z.union([z.number(), z.string()]),
  new_quality_score: z.string(),
});
const templateCategory = z.looseObject({
  message_template_id: z.union([z.number(), z.string()]),
  new_category: z.string(),
});
const phoneQuality = z.looseObject({ event: z.string(), current_limit: z.string().optional() });
const capability = z.looseObject({
  max_daily_conversations_per_business: z.union([z.number(), z.string()]).optional(),
  max_daily_conversation_per_phone: z.number().optional(),
});
const accountUpdate = z.looseObject({ event: z.string() });

/**
 * Meta's account-level webhooks (design.md#account-events): template, quality, limit and account changes. Each
 * keeps the database current, and the dangerous ones stop sending at once.
 */
@Injectable()
export class AccountEventsService {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly redis: Redis,
    private readonly templates: TemplatesRepository,
    private readonly accountsRepository: AccountsRepository,
    private readonly accounts: AccountsService,
    private readonly signals: CampaignSignals,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(AccountEventsService.name);
  }

  async handle({ field, value }: WebhookChangeData): Promise<void> {
    switch (field) {
      case 'message_template_status_update':
        return this.templateStatus(value);
      case 'message_template_quality_update': {
        const event = templateQuality.safeParse(value);
        if (event.success) {
          await this.templates.update(String(event.data.message_template_id), {
            quality: event.data.new_quality_score,
          });
        }
        return;
      }
      case 'template_category_update': {
        const event = templateCategory.safeParse(value);
        if (event.success) {
          await this.templates.update(String(event.data.message_template_id), {
            category: event.data.new_category,
          });
        }
        return;
      }
      case 'phone_number_quality_update':
        return this.phoneQuality(value);
      case 'business_capability_update':
        return this.capability(value);
      case 'account_update':
        return this.accountUpdate(value);
      default:
        this.logger.info({ field }, 'account event not handled');
    }
  }

  private async templateStatus(value: Readonly<Record<string, unknown>>): Promise<void> {
    const event = templateStatus.safeParse(value);
    if (!event.success) return;
    const {
      event: status,
      message_template_id: id,
      message_template_name: name,
      message_template_language: language,
    } = event.data;
    await this.templates.update(String(id), { status });
    if (!BLOCKED_TEMPLATE.has(status) || name === undefined || language === undefined) return;
    const paused = await this.signals.pauseTemplateUsers(
      { name, language },
      `template ${name} ${status.toLowerCase()} by Meta${event.data.reason ? `: ${event.data.reason}` : ''}`,
    );
    this.logger.error(
      { template: name, language, status, campaignsPaused: paused.length },
      'template blocked by Meta',
    );
  }

  private async phoneQuality(value: Readonly<Record<string, unknown>>): Promise<void> {
    const event = phoneQuality.safeParse(value);
    if (!event.success) return;
    await this.accountsRepository.setHealth(MAIN_ACCOUNT_ID, {
      quality: event.data.event,
      ...(event.data.current_limit === undefined ? {} : { messagingLimit: event.data.current_limit }),
    });
    if (QUALITY_BAD.has(event.data.event)) {
      await this.redis.set(
        keys.marketingPaused(MAIN_ACCOUNT_ID),
        `phone quality ${event.data.event.toLowerCase()}`,
      );
      this.logger.error({ event: event.data.event }, 'phone quality dropped: marketing paused');
    } else if (QUALITY_OK.has(event.data.event)) {
      await this.redis.del(keys.marketingPaused(MAIN_ACCOUNT_ID));
      this.logger.info({ event: event.data.event }, 'phone quality restored: marketing allowed');
    }
  }

  private async capability(value: Readonly<Record<string, unknown>>): Promise<void> {
    const event = capability.safeParse(value);
    if (!event.success) return;
    const limit = Number(
      event.data.max_daily_conversations_per_business ?? event.data.max_daily_conversation_per_phone,
    );
    if (!Number.isFinite(limit) || limit <= 0) return;
    await this.redis.set(keys.messagingLimit(this.config.account.portfolioId), String(limit));
    await this.accountsRepository.setHealth(MAIN_ACCOUNT_ID, { messagingLimit: String(limit) });
    this.logger.info({ limit }, 'messaging limit updated');
  }

  private async accountUpdate(value: Readonly<Record<string, unknown>>): Promise<void> {
    const event = accountUpdate.safeParse(value);
    if (!event.success) return;
    if (ACCOUNT_BLOCKED.test(event.data.event)) {
      await this.accounts.pause(`account ${event.data.event.toLowerCase()}`);
      this.logger.error({ event: event.data.event }, 'account restricted by Meta: sending paused');
    } else {
      this.logger.info({ event: event.data.event }, 'account update');
    }
  }
}
