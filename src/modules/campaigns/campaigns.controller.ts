import {
  Body,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type Actor, CurrentActor, RequirePermissions } from '../../common/auth/index.js';
import { ValidationError } from '../../common/errors/index.js';
import { InternalController } from '../../common/http/index.js';
import { Idempotent } from '../../infrastructure/idempotency/index.js';
import {
  createCampaignSchema,
  type CreateCampaign,
  listCampaignsQuery,
  type ListCampaignsQuery,
  objectId,
  previewAudienceSchema,
  type PreviewAudience,
  updateCampaignSchema,
  type UpdateCampaign,
} from './campaigns.schemas.js';
import { campaignView, CampaignsService } from './campaigns.service.js';
import { AudiencePreviewService } from './audience/audience-preview.service.js';
import { MAX_CSV_ROWS, type ReceivedFile, UploadsService, uploadView } from './uploads.service.js';

/** Campaign drafts and audience uploads (docs/modules/messaging/api.md#campaigns). */
@InternalController('')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly uploads: UploadsService,
    private readonly preview: AudiencePreviewService,
  ) {}

  @Get('campaigns')
  @RequirePermissions('campaigns:read')
  async list(@Query({ schema: listCampaignsQuery }) query: ListCampaignsQuery) {
    const page = await this.campaigns.list(query);
    return { items: page.items.map(campaignView), nextCursor: page.nextCursor };
  }

  @Post('campaigns')
  @Idempotent()
  @RequirePermissions('campaigns:write')
  async create(@Body({ schema: createCampaignSchema }) body: CreateCampaign, @CurrentActor() actor: Actor) {
    return campaignView(await this.campaigns.create(body, actor));
  }

  @Get('campaigns/:id')
  @RequirePermissions('campaigns:read')
  async get(@Param('id', { schema: objectId }) id: string) {
    return campaignView(await this.campaigns.get(id));
  }

  @Patch('campaigns/:id')
  @Idempotent()
  @RequirePermissions('campaigns:write')
  async update(
    @Param('id', { schema: objectId }) id: string,
    @Body({ schema: updateCampaignSchema }) body: UpdateCampaign,
    @CurrentActor() actor: Actor,
  ) {
    return campaignView(await this.campaigns.update(id, body, actor));
  }

  @Delete('campaigns/:id')
  @HttpCode(204)
  @RequirePermissions('campaigns:write')
  async delete(@Param('id', { schema: objectId }) id: string, @CurrentActor() actor: Actor): Promise<void> {
    await this.campaigns.delete(id, actor);
  }

  @Post('campaigns/:id/duplicate')
  @Idempotent()
  @RequirePermissions('campaigns:write')
  async duplicate(@Param('id', { schema: objectId }) id: string, @CurrentActor() actor: Actor) {
    return campaignView(await this.campaigns.duplicate(id, actor));
  }

  @Post('campaigns/:id/build')
  @HttpCode(202)
  @Idempotent()
  @RequirePermissions('campaigns:write')
  async build(@Param('id', { schema: objectId }) id: string, @CurrentActor() actor: Actor) {
    return campaignView(await this.campaigns.build(id, actor));
  }

  @Post('audiences/preview')
  @HttpCode(200)
  @RequirePermissions('campaigns:read')
  async previewAudience(@Body({ schema: previewAudienceSchema }) body: PreviewAudience) {
    return this.preview.preview(
      body.audience,
      body.templateId === undefined
        ? undefined
        : { templateId: body.templateId, variableMapping: body.variableMapping },
    );
  }

  @Get('audiences/options')
  @RequirePermissions('campaigns:read')
  async audienceOptions() {
    return this.preview.options();
  }

  @Post('uploads/csv')
  @Idempotent()
  @RequirePermissions('campaigns:write')
  // In memory: rare admin uploads, capped at 100 MB (about a million rows).
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024, files: 1 } }))
  async uploadCsv(@UploadedFile() file: ReceivedFile | undefined, @CurrentActor() actor: Actor) {
    if (file === undefined) {
      throw new ValidationError({
        file: `Attach the CSV as \`file\` (up to ${MAX_CSV_ROWS.toLocaleString('en-IN')} rows).`,
      });
    }
    return uploadView(await this.uploads.storeCsv(file, actor));
  }
}
