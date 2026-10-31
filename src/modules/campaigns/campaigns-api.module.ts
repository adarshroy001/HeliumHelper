import { Module } from '@nestjs/common';
import { CampaignReadsController } from './campaign-reads.controller.js';
import { CampaignsController } from './campaigns.controller.js';
import { CampaignsModule } from './campaigns.module.js';

/** The campaigns module's routes, for the API process only. */
@Module({ imports: [CampaignsModule], controllers: [CampaignsController, CampaignReadsController] })
export class CampaignsApiModule {}
