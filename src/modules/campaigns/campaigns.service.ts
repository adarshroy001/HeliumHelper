import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { Actor } from '../../common/auth/index.js';
import { DB, type Page, withTransaction } from '../../infrastructure/database/index.js';
import { AuditService } from '../audit/index.js';
import { MAIN_ACCOUNT_ID } from '../messaging/index.js';
import type { CampaignDocument } from './campaign.schema.js';
import { CampaignValidator } from './campaign-validator.js';
import type { CreateCampaign, ListCampaignsQuery, UpdateCampaign } from './campaigns.schemas.js';
import { CampaignNotFoundError, CampaignStateError } from './campaigns.errors.js';
import { CampaignsRepository } from './campaigns.repository.js';

/** A campaign as the API returns it. */
export function campaignView(c: CampaignDocument) {
  return {
    id: String(c._id),
    name: c.name,
    status: c.status,
    version: c.version,
    template: {
      id: c.template.templateId,
      name: c.template.name,
      language: c.template.language,
      category: c.template.category,
    },
    variableMapping: c.variableMapping,
    headerMedia: c.headerMedia ?? null,
    audience: c.audience,
    options: c.options,
    autoReply: c.autoReply ?? null,
    schedule: c.schedule ?? null,
    totals: c.totals ?? null,
    pauseReason: c.pauseReason ?? null,
    stopReason: c.stopReason ?? null,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    builtAt: c.builtAt ?? null,
    sendStartedAt: c.sendStartedAt ?? null,
    sendCompletedAt: c.sendCompletedAt ?? null,
    stoppedAt: c.stoppedAt ?? null,
    closedAt: c.closedAt ?? null,
  };
}

/** What can be edited, to compare before and after in the audit log. */
function editable(
  c: Pick<
    CampaignDocument,
    'name' | 'template' | 'variableMapping' | 'headerMedia' | 'audience' | 'options' | 'autoReply'
  >,
) {
  return {
    name: c.name,
    templateId: c.template.templateId,
    variableMapping: c.variableMapping,
    headerMediaId: c.headerMedia?.mediaId,
    audience: c.audience,
    options: c.options,
    autoReply: c.autoReply,
  };
}

/** Campaign drafts: create, edit, delete, duplicate, read (docs/modules/messaging/api.md#campaigns). */
@Injectable()
export class CampaignsService {
  constructor(
    @InjectConnection(DB.messaging) private readonly connection: Connection,
    private readonly campaigns: CampaignsRepository,
    private readonly validator: CampaignValidator,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateCampaign, actor: Actor): Promise<CampaignDocument> {
    const checked = await this.validator.check(input);
    return withTransaction(this.connection, async (session) => {
      const created = await this.campaigns.create(
        {
          name: input.name,
          accountId: MAIN_ACCOUNT_ID,
          status: 'draft',
          variableMapping: input.variableMapping,
          audience: input.audience,
          options: input.options,
          ...checked,
          createdBy: {
            service: actor.service,
            ...(actor.user === undefined ? {} : { userId: actor.user.id, email: actor.user.email }),
          },
        },
        session,
      );
      await this.audit.record(
        {
          actor,
          action: 'campaign.create',
          entity: { type: 'campaign', id: String(created._id) },
          after: editable(created),
        },
        session,
      );
      return created;
    });
  }

  async get(id: string): Promise<CampaignDocument> {
    const campaign = await this.campaigns.findById(id);
    if (campaign === null) throw new CampaignNotFoundError(id);
    return campaign;
  }

  async list(query: ListCampaignsQuery): Promise<Page<CampaignDocument>> {
    return this.campaigns.list(query.status === undefined ? {} : { status: query.status }, query);
  }

  /** Edits a draft. Fields left out keep their value; the result is validated as a whole. */
  async update(id: string, input: UpdateCampaign, actor: Actor): Promise<CampaignDocument> {
    const current = await this.get(id);
    if (current.status !== 'draft') throw new CampaignStateError(id, current.status, 'edited');
    const merged: CreateCampaign = {
      ...editable(current),
      autoReply: current.autoReply,
      ...input,
    };
    const checked = await this.validator.check(merged);
    return withTransaction(this.connection, async (session) => {
      const updated = await this.campaigns.transition(
        id,
        { from: ['draft'], version: current.version },
        {
          name: merged.name,
          variableMapping: merged.variableMapping,
          audience: merged.audience,
          options: merged.options,
          template: checked.template,
          ...(checked.headerMedia === undefined ? {} : { headerMedia: checked.headerMedia }),
          ...(checked.autoReply === undefined ? {} : { autoReply: checked.autoReply }),
        },
        {
          unset: [
            ...(checked.headerMedia === undefined ? ['headerMedia' as const] : []),
            ...(checked.autoReply === undefined ? ['autoReply' as const] : []),
          ],
          session,
        },
      );
      if (updated === null) throw new CampaignStateError(id, current.status, 'edited');
      await this.audit.record(
        {
          actor,
          action: 'campaign.update',
          entity: { type: 'campaign', id },
          before: editable(current),
          after: editable(updated),
        },
        session,
      );
      return updated;
    });
  }

  async delete(id: string, actor: Actor): Promise<void> {
    const current = await this.get(id);
    if (current.status !== 'draft') throw new CampaignStateError(id, current.status, 'deleted');
    await withTransaction(this.connection, async (session) => {
      if (!(await this.campaigns.delete(id, current.version, session)))
        throw new CampaignStateError(id, current.status, 'deleted');
      await this.audit.record(
        { actor, action: 'campaign.delete', entity: { type: 'campaign', id }, before: editable(current) },
        session,
      );
    });
  }

  /** A new draft with the same setup, checked again against today's templates and uploads. */
  async duplicate(id: string, actor: Actor): Promise<CampaignDocument> {
    const source = await this.get(id);
    const name = `Copy of ${source.name}`.slice(0, 120);
    const { templateId, variableMapping, headerMediaId, audience, options, autoReply } = editable(source);
    return this.create(
      {
        name,
        templateId,
        variableMapping,
        ...(headerMediaId === undefined ? {} : { headerMediaId }),
        audience,
        options,
        ...(autoReply === undefined ? {} : { autoReply }),
      },
      actor,
    );
  }
}
