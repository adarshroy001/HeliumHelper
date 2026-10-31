import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { MAIN_ACCOUNT_ID } from '../accounts.service.js';
import { Redis } from 'ioredis';
import { DeliveriesRepository } from '../data/deliveries.repository.js';
import { keys } from '../messaging.keys.js';
import { type DeliveryPayload, STATUS_RANK } from '../data/delivery.schema.js';
import type { TemplatePayload } from '../whatsapp/template.js';

/** A campaign recipient, ready to be written as a pending delivery. */
export interface CampaignRecipient {
  readonly to: string;
  readonly name?: string;
  readonly userId?: string;
  readonly template: TemplatePayload;
}

export type RetargetOutcome =
  'delivered_not_read' | 'read_no_reply' | 'replied' | 'button' | 'failed' | 'not_delivered';

/**
 * The delivery ledger as other modules see it (ADR-0015): the messaging module owns `deliveries`, and the campaigns
 * module writes and reads campaign deliveries only through this service.
 */
@Injectable()
export class DeliveryLedger {
  constructor(
    private readonly deliveries: DeliveriesRepository,
    private readonly redis: Redis,
  ) {}

  /**
   * Writes pending deliveries for a campaign, numbered from `firstSeq`. A recipient already in the campaign is
   * skipped (unique `dedupeKey`), so re-running a batch is safe.
   */
  async addCampaignRecipients(
    campaignId: string,
    firstSeq: number,
    recipients: readonly CampaignRecipient[],
  ): Promise<{ inserted: number; duplicates: number }> {
    const campaign = new Types.ObjectId(campaignId);
    const now = new Date();
    return this.deliveries.insertMany(
      recipients.map((r, i) => ({
        _id: new Types.ObjectId(),
        source: { kind: 'campaign' as const, id: campaignId },
        campaignId: campaign,
        seq: firstSeq + i,
        dedupeKey: `${campaignId}:${r.to}`,
        accountId: MAIN_ACCOUNT_ID,
        to: r.to,
        ...(r.name === undefined ? {} : { name: r.name }),
        ...(r.userId === undefined ? {} : { userId: r.userId }),
        payload: { kind: 'template' as const, template: r.template },
        status: 'pending' as const,
        statusRank: STATUS_RANK.pending,
        createdAt: now,
      })),
    );
  }

  /** Phones that got a campaign message from us within the frequency cap. */
  recentlyMessaged(phones: readonly string[], since: Date): Promise<Set<string>> {
    return this.deliveries.recentlyMessaged(phones, since);
  }

  countCampaign(campaignId: string): Promise<number> {
    return this.deliveries.countCampaign(campaignId);
  }

  campaignRecipients(campaignId: string, outcome: RetargetOutcome, button?: string) {
    return this.deliveries.campaignRecipients(campaignId, outcome, button);
  }

  /** Writes one-off messages (test sends, direct sends) as pending deliveries; returns their IDs in order. */
  async addMessages(
    kind: 'test' | 'direct',
    sourceId: string | undefined,
    messages: readonly { to: string; payload: DeliveryPayload }[],
  ): Promise<string[]> {
    const now = new Date();
    const docs = messages.map((m) => ({
      _id: new Types.ObjectId(),
      source: { kind, ...(sourceId === undefined ? {} : { id: sourceId }) },
      accountId: MAIN_ACCOUNT_ID,
      to: m.to,
      payload: m.payload,
      status: 'pending' as const,
      statusRank: STATUS_RANK.pending,
      createdAt: now,
    }));
    await this.deliveries.insertMany(docs);
    return docs.map((d) => String(d._id));
  }

  skipPending(campaignId: string, reason: string): Promise<number> {
    return this.deliveries.skipPending(campaignId, reason);
  }

  pendingAfter(campaignId: string, cursor: number, limit: number) {
    return this.deliveries.pendingAfter(campaignId, cursor, limit);
  }

  listCampaign(...args: Parameters<DeliveriesRepository['listCampaign']>) {
    return this.deliveries.listCampaign(...args);
  }

  campaignCursor(campaignId: string) {
    return this.deliveries.campaignCursor(campaignId);
  }

  deliveredAt(campaignId: string, phones: readonly string[]) {
    return this.deliveries.deliveredAt(campaignId, phones);
  }

  countByStatus(campaignId: string) {
    return this.deliveries.countByStatus(campaignId);
  }

  /**
   * Rebuilds a campaign's live counters and status ranks from its deliveries (the record), after Redis lost them.
   * Feeding starts again from the first pending delivery; claims keep anything already sent from going twice.
   */
  async rebuildCounters(campaignId: string, total: number): Promise<Record<string, number>> {
    const RANK: Record<string, number> = {
      pending: 0,
      accepted: 1,
      sent: 2,
      delivered: 3,
      read: 4,
      failed: -1,
      skipped: -2,
    };
    const counts: Record<string, number> = {
      total,
      fed: 0,
      accepted: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      skipped: 0,
      replied: 0,
    };
    const ranks = keys.ranks(campaignId);
    await this.redis.del(ranks, keys.counters(campaignId), keys.billed(campaignId));
    let batch: string[] = [];
    const billed: [string, string][] = [];
    for await (const d of this.deliveries.campaignCursor(campaignId)) {
      const id = String(d._id);
      const rank = RANK[d.status] ?? 0;
      if (d.status !== 'pending') counts['fed'] = (counts['fed'] ?? 0) + 1;
      if (rank >= 1 || (d.status === 'failed' && d.providerMessageId !== undefined))
        counts['accepted'] = (counts['accepted'] ?? 0) + 1;
      if (rank >= 2) counts['sent'] = (counts['sent'] ?? 0) + 1;
      if (rank >= 3) counts['delivered'] = (counts['delivered'] ?? 0) + 1;
      if (rank === 4) counts['read'] = (counts['read'] ?? 0) + 1;
      if (d.status === 'failed' || d.status === 'skipped') counts[d.status] = (counts[d.status] ?? 0) + 1;
      if (d.reply !== undefined) counts['replied'] = (counts['replied'] ?? 0) + 1;
      if (d.pricing?.billable === true) {
        const field = `billable:${d.pricing.category ?? 'unknown'}`;
        counts[field] = (counts[field] ?? 0) + 1;
        billed.push([id, d.pricing.category ?? 'unknown']);
      }
      if (rank !== 0) batch.push(id, String(rank));
      if (batch.length >= 2000) {
        await this.redis.hset(ranks, ...batch);
        batch = [];
      }
    }
    if (batch.length > 0) await this.redis.hset(ranks, ...batch);
    for (let i = 0; i < billed.length; i += 1000)
      await this.redis.hset(keys.billed(campaignId), ...billed.slice(i, i + 1000).flat());
    await this.redis.hset(
      keys.counters(campaignId),
      ...Object.entries(counts).flatMap(([field, n]) => [field, String(n)]),
    );
    await this.redis
      .multi()
      .del(keys.feedCursor(campaignId))
      .hset(keys.feedCursor(campaignId), 'cursor', '-1')
      .exec();
    return counts;
  }
}
