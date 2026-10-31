import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { maskPhone } from '../../../common/utils/mask-phone.js';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { QueuePublisher } from '../../../infrastructure/queue/index.js';
import { MAIN_ACCOUNT_ID } from '../accounts.service.js';
import { DeliveriesRepository } from '../data/deliveries.repository.js';
import { STATUS_RANK } from '../data/delivery.schema.js';
import {
  ConversationsRepository,
  InboundMessagesRepository,
  SuppressionsRepository,
} from '../data/messaging.repositories.js';
import { keys } from '../messaging.keys.js';
import { deliverySend, WA_SEND_P1_QUEUE } from '../messaging.messages.js';
import { CampaignCounters } from '../sending/campaign-counters.js';
import { type DeliveryRef, parseDeliveryRef } from '../statuses/delivery-ref.js';
import { AUTO_REPLY_MAX_AGE_MS, autoReplyFor, autoReplyId, autoReplyRuleSchema } from './auto-reply.js';
import { isOptOut, type ParsedInbound, previewOf } from './inbound-parser.js';

const SERVICE_WINDOW_SECONDS = 24 * 60 * 60;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Handles messages customers send us (design.md#inbound-messages): each is stored once by its wamid, opens the
 * service window, updates the inbox, and is attributed to the campaign message it replies to (never "the latest
 * message to that phone"). Then opt-outs, poll votes and the campaign's auto-reply.
 */
@Injectable()
export class InboundService {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly redis: Redis,
    private readonly inbound: InboundMessagesRepository,
    private readonly conversations: ConversationsRepository,
    private readonly deliveries: DeliveriesRepository,
    private readonly suppressions: SuppressionsRepository,
    private readonly counters: CampaignCounters,
    private readonly publisher: QueuePublisher,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(InboundService.name);
  }

  async handle(messages: readonly ParsedInbound[]): Promise<void> {
    const refs = await Promise.all(messages.map((m) => this.attribute(m)));
    const fresh = await this.inbound.insertNew(
      messages.map((m, i) => {
        const ref = refs[i];
        return {
          _id: m.wamid,
          accountId: MAIN_ACCOUNT_ID,
          from: m.from,
          ...(m.name === undefined ? {} : { name: m.name }),
          type: m.type,
          ...(m.text === undefined ? {} : { text: m.text }),
          ...(m.button === undefined ? {} : { button: m.button }),
          ...(m.media === undefined ? {} : { media: m.media }),
          ...(m.contextWamid === undefined ? {} : { contextWamid: m.contextWamid }),
          ...(ref?.deliveryId === undefined ? {} : { deliveryId: ref.deliveryId }),
          ...(ref?.campaignId === undefined ? {} : { campaignId: ref.campaignId }),
          receivedAt: m.at,
        };
      }),
    );

    // Only messages stored just now have effects; a duplicate webhook stops here.
    const now = messages
      .map((m, i) => ({ message: m, ref: refs[i] }))
      .filter(({ message }) => fresh.has(message.wamid));
    if (now.length === 0) return;
    const window = this.redis.pipeline();
    for (const { message } of now)
      window.set(keys.serviceWindow(message.from), '1', 'EX', SERVICE_WINDOW_SECONDS);
    await window.exec();
    await this.conversations.record(
      now.map(({ message }) => ({
        phone: message.from,
        accountId: MAIN_ACCOUNT_ID,
        direction: 'inbound' as const,
        at: message.at,
        preview: previewOf(message),
        ...(message.name === undefined ? {} : { name: message.name }),
      })),
    );
    for (const { message, ref } of now) await this.act(message, ref ?? null);
  }

  /** The delivery a message replies to, through `context.id`: the wamid map, then the database. */
  private async attribute(message: ParsedInbound): Promise<DeliveryRef | null> {
    if (message.contextWamid === undefined) return null;
    const mapped = parseDeliveryRef(await this.redis.get(keys.wamid(message.contextWamid)));
    return mapped ?? (await this.deliveries.findByWamid(message.contextWamid));
  }

  private async act(message: ParsedInbound, ref: DeliveryRef | null): Promise<void> {
    const campaignId = ref?.campaignId;
    if (ref !== null && campaignId !== undefined) {
      const { first } = await this.deliveries.recordReply(ref.deliveryId, message.at, message.button?.text);
      if (first) await this.counters.increment(campaignId, 'replied');
      if (message.button !== undefined) await this.vote(campaignId, ref.deliveryId, message.button.text);
    }

    if (isOptOut(message, this.config.optOut)) {
      await this.suppressions.add([
        {
          _id: message.from,
          reason: message.button === undefined ? 'keyword' : 'button',
          source: message.wamid,
        },
      ]);
      await this.redis.sadd(keys.suppressed(), message.from);
      // Once per campaign recipient, whichever of their messages created the suppression.
      if (ref !== null && campaignId !== undefined) {
        if ((await this.redis.hsetnx(keys.optOuts(campaignId), ref.deliveryId, '1')) === 1) {
          await this.counters.increment(campaignId, 'optedOut');
        }
      }
      this.logger.info({ from: maskPhone(message.from), campaignId }, 'opted out');
      return;
    }

    if (ref !== null && campaignId !== undefined) await this.autoReply(message, ref.deliveryId, campaignId);
  }

  /** One vote per recipient: the first button they tapped. */
  private async vote(campaignId: string, deliveryId: string, button: string): Promise<void> {
    if ((await this.redis.hsetnx(keys.votes(campaignId), deliveryId, button)) === 1) {
      await this.redis.hincrby(keys.buttons(campaignId), button, 1);
    }
  }

  private async autoReply(
    message: ParsedInbound,
    campaignDeliveryId: string,
    campaignId: string,
  ): Promise<void> {
    if (Date.now() - message.at.getTime() > AUTO_REPLY_MAX_AGE_MS) return;
    const raw = await this.redis.get(keys.autoReply(campaignId));
    if (raw === null) return;
    const rule = autoReplyRuleSchema.safeParse(parseJson(raw));
    if (!rule.success) {
      this.logger.warn({ campaignId }, 'auto-reply rule unreadable');
      return;
    }
    const original = await this.deliveries.findById(campaignDeliveryId);
    const payload = autoReplyFor(rule.data, message, {
      phone: message.from,
      ...(original?.name === undefined ? {} : { name: original.name }),
    });
    if (payload === null) return;

    const id = autoReplyId(campaignDeliveryId);
    const { inserted } = await this.deliveries.insertMany([
      {
        _id: id,
        source: { kind: 'auto_reply', id: campaignDeliveryId },
        accountId: MAIN_ACCOUNT_ID,
        to: message.from,
        payload,
        status: 'pending',
        statusRank: STATUS_RANK.pending,
        createdAt: new Date(),
      },
    ]);
    if (inserted === 0) {
      // Already created. Send it again only if it never went out: a lost publish is recovered, and the sender's
      // claim keeps it from reaching the customer twice.
      const existing = await this.deliveries.findById(id);
      if (existing?.status !== 'pending') return;
    }
    await this.publisher.publish(WA_SEND_P1_QUEUE, deliverySend, {
      deliveryId: id,
      accountId: MAIN_ACCOUNT_ID,
      phoneNumberId: this.config.account.phoneNumberId,
      to: message.from,
      endpoint: 'messages',
      payload,
      // A reply inside the window the customer just opened.
      businessInitiated: false,
    });
  }
}
