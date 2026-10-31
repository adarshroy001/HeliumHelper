import { Injectable } from '@nestjs/common';
import {
  extractTemplateVariables,
  headerMediaType,
  mappingProblem,
  MediaService,
  type TemplateComponent,
  TemplatesService,
} from '../messaging/index.js';
import type { CampaignAutoReply, CreateCampaign } from './campaigns.schemas.js';
import type { TemplateSnapshot } from './campaign.schema.js';
import { CampaignInvalidError } from './campaigns.errors.js';
import { CampaignsRepository, UploadsRepository } from './campaigns.repository.js';

export interface CheckedCampaign {
  readonly template: TemplateSnapshot;
  readonly headerMedia?: { type: 'image' | 'video' | 'document'; mediaId: string };
  readonly autoReply?: CampaignAutoReply;
}

/**
 * Checks a campaign's setup the way HeliumAdmin did (approved template, complete mapping, header media, auto-reply)
 * plus the new options, and collects every problem, so the composer can show them all at once.
 */
@Injectable()
export class CampaignValidator {
  constructor(
    private readonly templates: TemplatesService,
    private readonly media: MediaService,
    private readonly uploads: UploadsRepository,
    private readonly campaigns: CampaignsRepository,
  ) {}

  async check(input: CreateCampaign): Promise<CheckedCampaign> {
    const problems: string[] = [];
    const template = await this.templates.findById(input.templateId);
    if (template === null)
      throw new CampaignInvalidError(['The template was not found. Sync templates and try again.']);
    if (template.status !== 'APPROVED')
      problems.push(`The template is ${template.status.toLowerCase()}, not approved.`);
    const components = template.components as TemplateComponent[];

    const mapping = mappingProblem(extractTemplateVariables(components), input.variableMapping);
    if (mapping !== null) problems.push(`${mapping}.`);

    const csv =
      input.audience.csvUploadId === undefined
        ? null
        : await this.uploads.findById(input.audience.csvUploadId);
    if (input.audience.csvUploadId !== undefined && csv === null)
      problems.push('The CSV upload was not found.');
    for (const m of input.variableMapping) {
      if (!m.value.startsWith('csv:')) continue;
      const column = m.value.slice(4);
      if (csv === null)
        problems.push(`A variable uses the CSV column "${column}", but the audience has no CSV.`);
      else if (!csv.columns.includes(column)) problems.push(`The CSV has no column "${column}".`);
    }

    const headerMedia = await this.checkHeaderMedia(
      headerMediaType(components),
      input.headerMediaId,
      problems,
    );
    await this.checkAudience(input, problems);
    const autoReply =
      input.autoReply?.enabled === true ? await this.checkAutoReply(input.autoReply, problems) : undefined;
    const window = input.options.sendWindow;
    if (window !== undefined && window.start === window.end)
      problems.push('The send window starts and ends at the same time.');

    if (problems.length > 0) throw new CampaignInvalidError(problems);
    return {
      template: {
        templateId: template._id,
        name: template.name,
        language: template.language,
        category: template.category,
        components: template.components as Record<string, unknown>[],
      },
      ...(headerMedia === undefined ? {} : { headerMedia }),
      ...(autoReply === undefined ? {} : { autoReply }),
    };
  }

  private async checkHeaderMedia(
    needed: 'image' | 'video' | 'document' | null,
    mediaId: string | undefined,
    problems: string[],
  ): Promise<CheckedCampaign['headerMedia']> {
    if (needed === null) {
      if (mediaId !== undefined)
        problems.push("The template's header has no media; remove the header media.");
      return undefined;
    }
    if (mediaId === undefined) {
      problems.push(`The template needs a header ${needed}.`);
      return undefined;
    }
    const stored = await this.media.get(mediaId).catch(() => null);
    if (stored === null) problems.push('The header media was not found.');
    else if (stored.type !== needed) problems.push(`The header needs a ${needed}, not a ${stored.type}.`);
    return stored?.type === needed ? { type: needed, mediaId } : undefined;
  }

  private async checkAudience(input: CreateCampaign, problems: string[]): Promise<void> {
    const { sources, individual, csvUploadId, retarget, exclusions } = input.audience;
    if (
      sources.length === 0 &&
      individual.length === 0 &&
      csvUploadId === undefined &&
      retarget === undefined
    ) {
      problems.push('Choose an audience: customers, a CSV, individual contacts or an earlier campaign.');
    }
    if (exclusions?.uploadId !== undefined && (await this.uploads.findById(exclusions.uploadId)) === null) {
      problems.push('The exclusion list upload was not found.');
    }
    if (retarget !== undefined) {
      const earlier = await this.campaigns.findById(retarget.campaignId);
      if (
        earlier === null ||
        ['draft', 'building', 'ready', 'build_failed', 'scheduled'].includes(earlier.status)
      ) {
        problems.push('Retargeting needs a campaign that has been sent.');
      }
      if (retarget.outcome === 'button' && retarget.button === undefined)
        problems.push('Choose the button to retarget.');
    }
  }

  private async checkAutoReply(
    rule: NonNullable<CreateCampaign['autoReply']>,
    problems: string[],
  ): Promise<CampaignAutoReply | undefined> {
    if (rule.mode === 'text') {
      if ((rule.text ?? '').trim() === '' && (rule.choiceReplies ?? []).length === 0) {
        problems.push('The auto-reply needs a text.');
      }
      return rule;
    }
    const template = rule.templateId === undefined ? null : await this.templates.findById(rule.templateId);
    if (template?.status !== 'APPROVED') {
      problems.push('The auto-reply template must exist and be approved.');
      return undefined;
    }
    if (extractTemplateVariables(template.components as TemplateComponent[]).length > 0) {
      problems.push('The auto-reply template must have no variables.');
    }
    return { ...rule, template: { name: template.name, language: template.language } };
  }
}
