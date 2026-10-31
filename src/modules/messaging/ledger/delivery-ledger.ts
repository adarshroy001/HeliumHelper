import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { MAIN_ACCOUNT_ID } from '../accounts.service.js';
import { DeliveriesRepository } from '../data/deliveries.repository.js';
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
  constructor(private readonly deliveries: DeliveriesRepository) {}

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
}
