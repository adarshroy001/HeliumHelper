import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DB } from '../../infrastructure/database/index.js';
import { AuditModule } from '../audit/index.js';
import { MessagingModule } from '../messaging/index.js';
import { Campaign, CampaignSchema, CsvUpload, CsvUploadSchema } from './campaign.schema.js';
import { CampaignValidator } from './campaign-validator.js';
import { CampaignsRepository, UploadsRepository } from './campaigns.repository.js';
import { CampaignsService } from './campaigns.service.js';
import { UploadsService } from './uploads.service.js';

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
      ],
      DB.messaging,
    ),
  ],
  providers: [CampaignsRepository, UploadsRepository, CampaignValidator, CampaignsService, UploadsService],
  exports: [CampaignsService, UploadsService],
})
export class CampaignsModule {}
