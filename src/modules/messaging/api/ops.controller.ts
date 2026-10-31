import { Body, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { type Actor, CurrentActor, RequirePermissions } from '../../../common/auth/index.js';
import { InternalController } from '../../../common/http/index.js';
import { MessagingOpsService } from '../ops/messaging-ops.service.js';

const killSwitchSchema = z.strictObject({ on: z.boolean() });
const queueParam = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'Must be a queue name.');

/** Operations (docs/RUNBOOK.md#messaging): see and control sending without a deploy. */
@InternalController('ops')
@RequirePermissions('messaging:ops')
export class OpsController {
  constructor(private readonly ops: MessagingOpsService) {}

  @Get('messaging')
  async status() {
    return this.ops.status();
  }

  @Put('messaging/kill-switch')
  async killSwitch(
    @Body({ schema: killSwitchSchema }) body: z.infer<typeof killSwitchSchema>,
    @CurrentActor() actor: Actor,
  ) {
    await this.ops.setKillSwitch(body.on, actor);
    return { killSwitch: body.on };
  }

  @Post('queues/:queue/redrive')
  @HttpCode(200)
  async redrive(@Param('queue', { schema: queueParam }) queue: string, @CurrentActor() actor: Actor) {
    return this.ops.redrive(queue, actor);
  }

  @Post('accounts/main/resume')
  @HttpCode(204)
  async resumeAccount(@CurrentActor() actor: Actor): Promise<void> {
    await this.ops.resumeAccount(actor);
  }
}
