import { Module } from '@nestjs/common';
import { CampaignOpsController } from './campaign-ops.controller.js';
import { CampaignReadsController } from './campaign-reads.controller.js';
import { CampaignsController } from './campaigns.controller.js';
import { AuditModule } from '../audit/index.js';
import { CampaignsModule } from './campaigns.module.js';

/** The campaigns module's routes, for the API process only. */
@Module({
  imports: [CampaignsModule, AuditModule],
  controllers: [CampaignsController, CampaignReadsController, CampaignOpsController],
})
export class CampaignsApiModule {}
