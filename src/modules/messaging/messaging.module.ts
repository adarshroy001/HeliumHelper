import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { whatsappConfig, type WhatsappConfig } from '../../config/index.js';
import { DB } from '../../infrastructure/database/index.js';
import { AccountsService } from './accounts.service.js';
import { DeliveriesRepository } from './data/deliveries.repository.js';
import { Delivery, DeliverySchema } from './data/delivery.schema.js';
import {
  AccountsRepository,
  ConversationsRepository,
  InboundMessagesRepository,
  SuppressionsRepository,
  UnmatchedStatusesRepository,
} from './data/messaging.repositories.js';
import {
  Conversation,
  ConversationSchema,
  InboundMessage,
  InboundMessageSchema,
  Media,
  MediaSchema,
  Suppression,
  SuppressionSchema,
  Template,
  TemplateSchema,
  UnmatchedStatus,
  UnmatchedStatusSchema,
  WaAccount,
  WaAccountSchema,
} from './data/messaging.schemas.js';
import { GraphClient } from './whatsapp/graph-client.js';

/**
 * WhatsApp messaging (ADR-0015): accounts, templates, the delivery ledger, the sender, statuses, inbound
 * messages, suppressions and the inbox. See docs/modules/messaging/. Both processes import it: the worker for
 * its consumers, the API through `MessagingApiModule`, which adds the routes.
 */
@Module({
  imports: [
    MongooseModule.forFeature(
      [
        { name: Delivery.name, schema: DeliverySchema },
        { name: WaAccount.name, schema: WaAccountSchema },
        { name: Template.name, schema: TemplateSchema },
        { name: Media.name, schema: MediaSchema },
        { name: InboundMessage.name, schema: InboundMessageSchema },
        { name: Conversation.name, schema: ConversationSchema },
        { name: Suppression.name, schema: SuppressionSchema },
        { name: UnmatchedStatus.name, schema: UnmatchedStatusSchema },
      ],
      DB.messaging,
    ),
  ],
  providers: [
    AccountsService,
    AccountsRepository,
    DeliveriesRepository,
    InboundMessagesRepository,
    ConversationsRepository,
    SuppressionsRepository,
    UnmatchedStatusesRepository,
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
