import { Get, Header, Headers, HttpCode, Post, Query, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../../common/auth/index.js';
import { WebhookController } from '../../../common/http/index.js';
import { WebhookIntakeService } from './webhook-intake.service.js';

/** Meta's WhatsApp webhooks: `/webhooks/whatsapp`. Authenticated by Meta's signature, not a token. */
@Public()
@ApiExcludeController()
@WebhookController('whatsapp')
export class WhatsappWebhookController {
  constructor(private readonly intake: WebhookIntakeService) {}

  @Get()
  @Header('Content-Type', 'text/plain')
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    return this.intake.verify(mode, token, challenge);
  }

  @Post()
  @HttpCode(200)
  async receive(
    // `rawBody` holds the exact bytes Meta signed (`rawBody: true` in src/app.setup.ts).
    @Req() request: { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string | undefined,
  ): Promise<void> {
    await this.intake.accept(request.rawBody, signature);
  }
}
