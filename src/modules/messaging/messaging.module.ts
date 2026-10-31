import { Module } from '@nestjs/common';
import { whatsappConfig, type WhatsappConfig } from '../../config/index.js';
import { WebhookIntakeService } from './webhooks/webhook-intake.service.js';
import { WhatsappWebhookController } from './webhooks/whatsapp-webhook.controller.js';
import { GraphClient } from './whatsapp/graph-client.js';

/**
 * WhatsApp messaging (ADR-0015): accounts, templates, the delivery ledger, the sender, webhooks, statuses,
 * inbound messages, suppressions and the inbox. See docs/modules/messaging/.
 */
@Module({
  controllers: [WhatsappWebhookController],
  providers: [
    WebhookIntakeService,
    {
      provide: GraphClient,
      inject: [whatsappConfig.KEY],
      useFactory: (config: WhatsappConfig) =>
        new GraphClient({
          baseUrl: config.graphUrl,
          version: config.graphVersion,
          accessToken: config.accessToken,
        }),
    },
  ],
  exports: [GraphClient],
})
export class MessagingModule {}
