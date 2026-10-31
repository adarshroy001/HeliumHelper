import { Module } from '@nestjs/common';
import { InboxController } from './api/inbox.controller.js';
import { MessagingApiController } from './api/messaging-api.controller.js';
import { MessagingModule } from './messaging.module.js';
import { WebhookIntakeService } from './webhooks/webhook-intake.service.js';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller.js';

/** The messaging module's HTTP side, for the API process only: webhooks now, the internal API later. */
@Module({
  imports: [MessagingModule],
  controllers: [WhatsappWebhookController, MessagingApiController, InboxController],
  providers: [WebhookIntakeService],
})
export class MessagingApiModule {}
