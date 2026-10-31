import { Get, Header, HttpCode, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { type Actor, CurrentActor, RequirePermissions } from '../../common/auth/index.js';
import { InternalController } from '../../common/http/index.js';
import { Idempotent } from '../../infrastructure/idempotency/index.js';
import {
  listDeliveriesQuery,
  type ListDeliveriesQuery,
  listRepliesQuery,
  type ListRepliesQuery,
  objectId,
} from './campaigns.schemas.js';
import { CampaignsService } from './campaigns.service.js';
import { CampaignAttributionService } from './reads/campaign-attribution.js';
import { CampaignExportsService } from './reads/campaign-export.js';
import { CampaignReadsService } from './reads/campaign-reads.service.js';

/** What HeliumAdmin shows about a campaign: stats, recipients, replies, attribution, exports. */
@InternalController('')
@RequirePermissions('campaigns:read')
export class CampaignReadsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly reads: CampaignReadsService,
    private readonly attribution: CampaignAttributionService,
    private readonly exports: CampaignExportsService,
  ) {}

  @Get('campaigns/:id/stats')
  async stats(@Param('id', { schema: objectId }) id: string) {
    return this.reads.stats(await this.campaigns.get(id));
  }

  @Get('campaigns/:id/deliveries')
  async deliveries(
    @Param('id', { schema: objectId }) id: string,
    @Query({ schema: listDeliveriesQuery }) query: ListDeliveriesQuery,
  ) {
    return this.reads.deliveries(await this.campaigns.get(id), query);
  }

  @Get('campaigns/:id/replies')
  async replies(
    @Param('id', { schema: objectId }) id: string,
    @Query({ schema: listRepliesQuery }) query: ListRepliesQuery,
  ) {
    return this.reads.replies(await this.campaigns.get(id), query);
  }

  @Get('campaigns/:id/attribution')
  async attributionOf(@Param('id', { schema: objectId }) id: string) {
    return { attribution: await this.attribution.attribution(await this.campaigns.get(id)) };
  }

  @Post('campaigns/:id/exports')
  @HttpCode(202)
  @Idempotent()
  async requestExport(@Param('id', { schema: objectId }) id: string, @CurrentActor() actor: Actor) {
    const campaign = await this.campaigns.get(id);
    const created = await this.exports.request(String(campaign._id), actor);
    return { id: String(created._id), status: created.status };
  }

  @Get('exports/:id')
  async exportStatus(@Param('id', { schema: objectId }) id: string) {
    const found = await this.exports.get(id);
    return {
      id: String(found._id),
      campaignId: found.campaignId,
      status: found.status,
      rows: found.rows ?? null,
      error: found.error ?? null,
    };
  }

  @Get('exports/:id/file')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportFile(@Param('id', { schema: objectId }) id: string): Promise<StreamableFile> {
    const { stream, filename } = await this.exports.file(id);
    return new StreamableFile(stream, { disposition: `attachment; filename="${filename}"` });
  }
}
