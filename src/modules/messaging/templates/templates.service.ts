import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Actor } from '../../../common/auth/index.js';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { AuditService } from '../../audit/index.js';
import { MAIN_ACCOUNT_ID } from '../accounts.service.js';
import { AccountsRepository, TemplatesRepository } from '../data/messaging.repositories.js';
import type { Template } from '../data/messaging.schemas.js';
import { TemplateNotFoundError, TemplateSyncFailedError } from '../messaging.errors.js';
import { GraphClient } from '../whatsapp/graph-client.js';

/** Keeps the `templates` mirror and the account's quality in step with Meta (every 15 minutes, and on demand). */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly graph: GraphClient,
    private readonly templates: TemplatesRepository,
    private readonly accounts: AccountsRepository,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(TemplatesService.name);
  }

  async get(id: string): Promise<Template> {
    const template = await this.templates.findById(id);
    if (template === null) throw new TemplateNotFoundError(id);
    return template;
  }

  async findById(id: string): Promise<Template | null> {
    return this.templates.findById(id);
  }

  async findByName(name: string, language: string): Promise<Template | null> {
    return this.templates.find(MAIN_ACCOUNT_ID, name, language);
  }

  async list(status?: string): Promise<Template[]> {
    return this.templates.list(MAIN_ACCOUNT_ID, status);
  }

  /** A sync an admin asked for, recorded in the audit log. */
  async syncFor(actor: Actor): Promise<number> {
    const count = await this.sync();
    await this.audit.record({
      actor,
      action: 'template.sync',
      entity: { type: 'templates', id: 'all' },
      after: { count },
    });
    return count;
  }

  /** Syncs templates from Meta; returns how many there are. */
  async sync(): Promise<number> {
    const result = await this.graph.listTemplates(this.config.account.wabaId);
    if (!result.ok) throw new TemplateSyncFailedError(result.detail);
    const count = await this.templates.replaceAll(
      MAIN_ACCOUNT_ID,
      result.templates.map((t) => ({
        _id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        quality: t.quality,
        components: [...t.components],
      })),
    );

    // The number's quality and limit, best effort: a failure here doesn't fail the template sync.
    const phone = await this.graph.getPhoneNumber(this.config.account.phoneNumberId);
    if (phone.ok) {
      await this.accounts.setHealth(MAIN_ACCOUNT_ID, {
        ...(phone.phone.qualityRating === undefined ? {} : { quality: phone.phone.qualityRating }),
        ...(phone.phone.messagingLimit === undefined ? {} : { messagingLimit: phone.phone.messagingLimit }),
      });
    }
    this.logger.info({ templates: count }, 'templates synced');
    return count;
  }
}
