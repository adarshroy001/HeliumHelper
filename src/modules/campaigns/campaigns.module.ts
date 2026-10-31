import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DB } from '../../infrastructure/database/index.js';
import { AuditModule } from '../audit/index.js';
import { MessagingModule } from '../messaging/index.js';
import {
  Campaign,
  CampaignExport,
  CampaignExportSchema,
  CampaignSchema,
  CsvUpload,
  CsvUploadSchema,
} from './campaign.schema.js';
import { CampaignAttributionService } from './reads/campaign-attribution.js';
import { CampaignExportsService } from './reads/campaign-export.js';
import { CampaignReadsService } from './reads/campaign-reads.service.js';
import { CampaignValidator } from './campaign-validator.js';
import { CampaignsRepository, UploadsRepository } from './campaigns.repository.js';
import { CampaignsService } from './campaigns.service.js';
import { UploadsService } from './uploads.service.js';
import { AudienceBuilder } from './audience/audience-builder.js';
import { AudiencePreviewService } from './audience/audience-preview.service.js';
import { AudienceSourcesRepository } from './audience/audience-sources.repository.js';
import { CampaignControlConsumer } from './control/campaign-control.consumer.js';
import { CampaignFeeder } from './feeder/campaign-feeder.js';
import { CampaignActivationService } from './lifecycle/campaign-activation.service.js';
import { CampaignLifecycleService } from './lifecycle/campaign-lifecycle.service.js';
import { CampaignSweeper } from './lifecycle/campaign-sweeper.service.js';

/**
 * WhatsApp campaigns (ADR-0015): drafts, audiences, the build, the feeder, the lifecycle, stats and exports. Uses
 * the messaging module only through its exports. Both processes import it; the API adds `CampaignsApiModule`.
 */
@Module({
  imports: [
    AuditModule,
    MessagingModule,
    MongooseModule.forFeature(
      [
        { name: Campaign.name, schema: CampaignSchema },
        { name: CsvUpload.name, schema: CsvUploadSchema },
        { name: CampaignExport.name, schema: CampaignExportSchema },
      ],
      DB.messaging,
    ),
  ],
  providers: [
    CampaignsRepository,
    UploadsRepository,
    AudienceSourcesRepository,
    CampaignValidator,
    CampaignsService,
    UploadsService,
    AudienceBuilder,
    AudiencePreviewService,
    CampaignControlConsumer,
    CampaignLifecycleService,
    CampaignActivationService,
    CampaignSweeper,
    CampaignFeeder,
    CampaignReadsService,
    CampaignExportsService,
    CampaignAttributionService,
  ],
  exports: [
    CampaignsService,
    UploadsService,
    AudiencePreviewService,
    CampaignLifecycleService,
    CampaignReadsService,
    CampaignExportsService,
    CampaignAttributionService,
  ],
})
export class CampaignsModule {}
