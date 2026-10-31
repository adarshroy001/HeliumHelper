import { Module } from '@nestjs/common';
import { MessagingModule } from './messaging.module.js';
import { WebhookIntakeService } from './webhooks/webhook-intake.service.js';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller.js';

/** The messaging module's HTTP side, for the API process only: webhooks now, the internal API later. */
@Module({
  imports: [MessagingModule],
  controllers: [WhatsappWebhookController],
  providers: [WebhookIntakeService],
})
export class MessagingApiModule {}
