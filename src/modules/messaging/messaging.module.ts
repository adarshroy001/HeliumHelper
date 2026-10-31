import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { whatsappConfig, type WhatsappConfig } from '../../config/index.js';
import { DB } from '../../infrastructure/database/index.js';
import { AuditModule } from '../audit/index.js';
import { AccountsService } from './accounts.service.js';
import { MediaService } from './api/media.service.js';
import { MediaRepository } from './data/media.repository.js';
import { DeliveriesRepository } from './data/deliveries.repository.js';
import { Delivery, DeliverySchema } from './data/delivery.schema.js';
import {
  AccountsRepository,
  ConversationsRepository,
  InboundMessagesRepository,
  SuppressionsRepository,
  TemplatesRepository,
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
import { CampaignCounters } from './sending/campaign-counters.js';
import { RateLimiter } from './sending/rate-limiter.js';
import { SendP1Consumer, SendP2Consumer } from './sending/send.consumers.js';
import { SendFlusher } from './sending/send-flusher.js';
import { SenderService } from './sending/sender.service.js';
import { AccountEventsService } from './account/account-events.service.js';
import { AccountConsumer } from './account/account.consumer.js';
import { InboundConsumer } from './inbound/inbound.consumer.js';
import { MessagingJobsConsumer } from './jobs/messaging-jobs.consumer.js';
import { CampaignSignals } from './sending/campaign-signals.js';
import { TemplatesService } from './templates/templates.service.js';
import { InboundService } from './inbound/inbound.service.js';
import { StatusConsumer } from './statuses/status.consumer.js';
import { StatusService } from './statuses/status.service.js';
import { GraphClient } from './whatsapp/graph-client.js';

/**
 * WhatsApp messaging (ADR-0015): accounts, templates, the delivery ledger, the sender, statuses, inbound
 * messages, suppressions and the inbox. See docs/modules/messaging/. Both processes import it: the worker for
 * its consumers, the API through `MessagingApiModule`, which adds the routes.
 */
@Module({
  imports: [
    AuditModule,
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
    TemplatesRepository,
    MediaRepository,
    MediaService,
    CampaignCounters,
    CampaignSignals,
    TemplatesService,
    AccountEventsService,
    AccountConsumer,
    MessagingJobsConsumer,
    RateLimiter,
    SendFlusher,
    SenderService,
    SendP1Consumer,
    SendP2Consumer,
    StatusService,
    StatusConsumer,
    InboundService,
    InboundConsumer,
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
  exports: [GraphClient, CampaignCounters, CampaignSignals, TemplatesService, AccountsService, MediaService],
})
export class MessagingModule {}
