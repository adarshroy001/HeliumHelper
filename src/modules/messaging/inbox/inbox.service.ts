import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Actor } from '../../../common/auth/index.js';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { QueuePublisher } from '../../../infrastructure/queue/index.js';
import { AuditService } from '../../audit/index.js';
import { MAIN_ACCOUNT_ID } from '../accounts.service.js';
import { MediaService } from '../api/media.service.js';
import { ContactsRepository } from '../data/contacts.repository.js';
import { DeliveriesRepository } from '../data/deliveries.repository.js';
import type { DeliveryPayload } from '../data/delivery.schema.js';
import {
  ConversationsRepository,
  InboundMessagesRepository,
  SuppressionsRepository,
} from '../data/messaging.repositories.js';
import { ServiceWindowClosedError, TemplateNotApprovedError } from '../messaging.errors.js';
import { keys } from '../messaging.keys.js';
import { deliverySend, WA_SEND_P1_QUEUE } from '../messaging.messages.js';
import { DeliveryLedger } from '../ledger/delivery-ledger.js';
import { TemplatesService } from '../templates/templates.service.js';
import { buildTemplatePayload, headerMediaType, type TemplateComponent } from '../whatsapp/template.js';

/** A direct message: free text (inside the 24-hour window) or an approved template with its values. */
export type DirectMessage =
  | { readonly text: string }
  | {
      readonly template: {
        readonly templateId: string;
        readonly header?: readonly string[];
        readonly body?: readonly string[];
        readonly buttons?: readonly { readonly index: number; readonly parameters: readonly string[] }[];
        readonly headerMediaId?: string;
      };
    };

/**
 * The inbox (docs/modules/messaging/api.md#inbox-and-contacts): conversations, a contact's profile and timeline,
 * and direct sends, which go through the same sender as campaigns (`wa-send-p1`).
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly redis: Redis,
    private readonly conversations: ConversationsRepository,
    private readonly inbound: InboundMessagesRepository,
    private readonly deliveries: DeliveriesRepository,
    private readonly suppressions: SuppressionsRepository,
    private readonly contacts: ContactsRepository,
    private readonly templates: TemplatesService,
    private readonly media: MediaService,
    private readonly ledger: DeliveryLedger,
    private readonly publisher: QueuePublisher,
    private readonly audit: AuditService,
  ) {}

  conversationList(unreadOnly: boolean, before: Date | undefined, limit: number) {
    return this.conversations.list(unreadOnly, before, limit);
  }

  /** Everything the contact page shows: the customer, the window, the opt-out, and both sides of the chat. */
  async contact(phone: string, before: Date | undefined, limit: number) {
    const [profile, conversation, suppression, windowTtl, sent, received] = await Promise.all([
      this.contacts.byPhone(phone),
      this.conversations.findByPhone(phone),
      this.suppressions.findByPhone(phone),
      this.redis.ttl(keys.serviceWindow(phone)),
      this.deliveries.timeline(phone, before, limit),
      this.inbound.timeline(phone, before, limit),
    ]);
    const timeline = [
      ...sent.map((d) => ({
        direction: 'outbound' as const,
        id: String(d._id),
        at: d.createdAt,
        kind: d.source.kind,
        campaignId: d.campaignId === undefined ? null : String(d.campaignId),
        status: d.status,
        text: d.payload.kind === 'text' ? d.payload.text : null,
        template: d.payload.kind === 'template' ? d.payload.template.name : null,
        error: d.error ?? null,
      })),
      ...received.map((m) => ({
        direction: 'inbound' as const,
        id: m._id,
        at: m.receivedAt,
        type: m.type,
        text: m.text ?? null,
        button: m.button ?? null,
        campaignId: m.campaignId ?? null,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit);
    return {
      phone,
      profile,
      unread: conversation?.unread ?? 0,
      serviceWindowOpenUntil: windowTtl > 0 ? new Date(Date.now() + windowTtl * 1000) : null,
      suppressed: suppression === null ? null : { reason: suppression.reason, since: suppression.createdAt },
      timeline,
      nextBefore: timeline.length === limit ? (timeline.at(-1)?.at ?? null) : null,
    };
  }

  markRead(phone: string): Promise<void> {
    return this.conversations.markRead(phone);
  }

  search(query: string) {
    return this.contacts.search(query);
  }

  /** Queues a direct message; returns its delivery ID. Free text needs the customer's 24-hour window open. */
  async send(phone: string, message: DirectMessage, actor: Actor): Promise<{ deliveryId: string }> {
    let payload: DeliveryPayload;
    let category = 'service';
    if ('text' in message) {
      if ((await this.redis.exists(keys.serviceWindow(phone))) === 0)
        throw new ServiceWindowClosedError(phone);
      payload = { kind: 'text', text: message.text };
    } else {
      const template = await this.templates.get(message.template.templateId);
      if (template.status !== 'APPROVED') throw new TemplateNotApprovedError(template._id, template.status);
      category = template.category;
      const mediaType = headerMediaType(template.components as TemplateComponent[]);
      // Uploading media to Meta is rare here: campaigns keep it fresh, and a reused file is uploaded at most monthly.
      const headerMedia =
        mediaType !== null && message.template.headerMediaId !== undefined
          ? { type: mediaType, id: await this.media.ensureOnMeta(message.template.headerMediaId) }
          : undefined;
      payload = {
        kind: 'template',
        template: buildTemplatePayload({
          name: template.name,
          language: template.language,
          params: {
            header: message.template.header ?? [],
            body: message.template.body ?? [],
            buttons: message.template.buttons ?? [],
          },
          ...(headerMedia === undefined ? {} : { headerMedia }),
        }),
      };
    }

    const [deliveryId] = await this.ledger.addMessages('direct', actor.user?.id, [{ to: phone, payload }]);
    if (deliveryId === undefined) throw new RangeError('delivery was not created');
    await this.publisher.publish(WA_SEND_P1_QUEUE, deliverySend, {
      deliveryId,
      accountId: MAIN_ACCOUNT_ID,
      phoneNumberId: this.config.account.phoneNumberId,
      to: phone,
      endpoint: category === 'MARKETING' ? this.config.account.marketingEndpoint : 'messages',
      payload,
      businessInitiated: payload.kind === 'template',
    });
    await this.conversations.record([
      {
        phone,
        accountId: MAIN_ACCOUNT_ID,
        direction: 'outbound',
        at: new Date(),
        preview: payload.kind === 'text' ? payload.text : `[${payload.template.name}]`,
      },
    ]);
    await this.audit.record({
      actor,
      action: 'contact.message',
      entity: { type: 'contact', id: phone },
      after: { kind: payload.kind, deliveryId },
    });
    return { deliveryId };
  }
}
