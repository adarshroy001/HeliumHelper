import { HttpCode, Param, Post } from '@nestjs/common';
import { type Actor, CurrentActor, RequirePermissions } from '../../common/auth/index.js';
import { InternalController } from '../../common/http/index.js';
import { AuditService } from '../audit/index.js';
import { objectId } from './campaigns.schemas.js';
import { CampaignsService } from './campaigns.service.js';
import { CampaignLifecycleService } from './lifecycle/campaign-lifecycle.service.js';

/** Campaign operations: rebuilding a campaign's live counters from the database after Redis lost them. */
@InternalController('ops/campaigns')
@RequirePermissions('messaging:ops')
export class CampaignOpsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly lifecycle: CampaignLifecycleService,
    private readonly audit: AuditService,
  ) {}

  @Post(':id/reconcile')
  @HttpCode(200)
  async reconcile(@Param('id', { schema: objectId }) id: string, @CurrentActor() actor: Actor) {
    const counts = await this.lifecycle.reconcile(await this.campaigns.get(id));
    await this.audit.record({ actor, action: 'campaign.reconcile', entity: { type: 'campaign', id } });
    return { counts };
  }
}
