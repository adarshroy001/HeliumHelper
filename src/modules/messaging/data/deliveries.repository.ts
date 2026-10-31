import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type AnyBulkWriteOperation, type Model, mongo, Types } from 'mongoose';
import { DB } from '../../../infrastructure/database/index.js';
import { duplicateKeyIndexes } from './duplicate-keys.js';
import { Delivery, type DeliveryError, type DeliveryStatus, STATUS_RANK } from './delivery.schema.js';

/** A delivery ID as messages carry it: an ObjectId's hex, or a deterministic string ID (auto-replies). */
export function toDeliveryId(id: string): Types.ObjectId | string {
  return Types.ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? new Types.ObjectId(id) : id;
}

/** The sender's result for one delivery, written in its batched flush (design.md#sender-loop). */
export type SendOutcome =
  | { readonly id: string; readonly result: 'accepted'; readonly wamid: string; readonly at: Date }
  | { readonly id: string; readonly result: 'failed'; readonly error: DeliveryError; readonly at: Date }
  | { readonly id: string; readonly result: 'skipped'; readonly reason: string; readonly at: Date };

/** One status from a webhook, already correlated to its delivery. */
export interface StatusUpdate {
  readonly id: string;
  readonly status: Extract<DeliveryStatus, 'sent' | 'delivered' | 'read' | 'failed'>;
  readonly at: Date;
  readonly wamid: string;
  readonly error?: DeliveryError;
  readonly pricing?: { readonly category?: string; readonly billable?: boolean };
}

type NewDelivery = Omit<Delivery, '_id'> & { _id?: Types.ObjectId | string };

/**
 * The only code that writes `deliveries`. Hot-path writes are one `bulkWrite` per batch, each update guarded by
 * the status rank so duplicates and out-of-order events change nothing.
 */
@Injectable()
export class DeliveriesRepository {
  constructor(@InjectModel(Delivery.name, DB.messaging) private readonly model: Model<Delivery>) {}

  /**
   * Inserts deliveries, unordered. A duplicate (`dedupeKey` or `_id`) is skipped and counted, never an error, so a
   * re-run of the same batch is safe.
   */
  async insertMany(deliveries: readonly NewDelivery[]): Promise<{ inserted: number; duplicates: number }> {
    if (deliveries.length === 0) return { inserted: 0, duplicates: 0 };
    try {
      await this.model.collection.insertMany(deliveries as unknown as mongo.OptionalId<mongo.Document>[], {
        ordered: false,
      });
      return { inserted: deliveries.length, duplicates: 0 };
    } catch (error) {
      const duplicates = duplicateKeyIndexes(error);
      if (duplicates === null) throw error;
      return { inserted: deliveries.length - duplicates.length, duplicates: duplicates.length };
    }
  }

  async findById(id: string): Promise<Delivery | null> {
    return this.model.findById(toDeliveryId(id)).lean<Delivery>().exec();
  }

  /** The delivery Meta knows by this wamid: its ID and campaign, for correlation. */
  async findByWamid(wamid: string): Promise<{ deliveryId: string; campaignId?: string } | null> {
    const found = await this.model
      .findOne({ providerMessageId: wamid }, { _id: 1, campaignId: 1 })
      .lean<{ _id: Types.ObjectId | string; campaignId?: Types.ObjectId }>()
      .exec();
    if (found === null) return null;
    return {
      deliveryId: String(found._id),
      ...(found.campaignId ? { campaignId: String(found.campaignId) } : {}),
    };
  }

  /**
   * Records a reply to a delivery: first and last time, count, last button. Returns whether it was the first reply,
   * so `replied` is counted once per delivery.
   */
  async recordReply(id: string, at: Date, button?: string): Promise<{ first: boolean }> {
    const _id = toDeliveryId(id);
    const first = await this.model
      .updateOne(
        { _id, reply: { $exists: false } },
        {
          $set: {
            reply: {
              firstAt: at,
              lastAt: at,
              count: 1,
              ...(button === undefined ? {} : { lastButton: button }),
            },
          },
        },
      )
      .exec();
    if (first.modifiedCount === 1) return { first: true };
    await this.model
      .updateOne(
        { _id },
        {
          $max: { 'reply.lastAt': at },
          $inc: { 'reply.count': 1 },
          ...(button === undefined ? {} : { $set: { 'reply.lastButton': button } }),
        },
      )
      .exec();
    return { first: false };
  }

  /** Writes a batch of send results in one round trip. */
  async applySendOutcomes(outcomes: readonly SendOutcome[]): Promise<void> {
    const ops: AnyBulkWriteOperation<Delivery>[] = [];
    for (const outcome of outcomes) {
      const _id = toDeliveryId(outcome.id);
      if (outcome.result === 'accepted') {
        // The wamid is recorded even if a status webhook already moved the delivery past `accepted`.
        ops.push({
          updateOne: {
            filter: { _id },
            update: { $set: { providerMessageId: outcome.wamid, acceptedAt: outcome.at } },
          },
        });
        ops.push({
          updateOne: {
            filter: { _id, statusRank: { $lt: STATUS_RANK.accepted } },
            update: { $set: { status: 'accepted', statusRank: STATUS_RANK.accepted } },
          },
        });
      } else if (outcome.result === 'failed') {
        ops.push({
          updateOne: {
            filter: { _id, statusRank: { $lt: STATUS_RANK.delivered } },
            update: {
              $set: {
                status: 'failed',
                statusRank: STATUS_RANK.failed,
                failedAt: outcome.at,
                error: outcome.error,
              },
            },
          },
        });
      } else {
        ops.push({
          updateOne: {
            filter: { _id, statusRank: STATUS_RANK.pending },
            update: {
              $set: {
                status: 'skipped',
                statusRank: STATUS_RANK.skipped,
                skippedAt: outcome.at,
                skipReason: outcome.reason,
              },
            },
          },
        });
      }
    }
    if (ops.length > 0) await this.model.bulkWrite(ops, { ordered: false });
  }

  /** Applies a batch of webhook statuses in one round trip; each only over a lower rank. */
  async applyStatuses(updates: readonly StatusUpdate[]): Promise<void> {
    const ops: AnyBulkWriteOperation<Delivery>[] = [];
    for (const update of updates) {
      const _id = toDeliveryId(update.id);
      const rank = STATUS_RANK[update.status];
      const ceiling = update.status === 'failed' ? STATUS_RANK.delivered : rank;
      ops.push({
        updateOne: {
          filter: { _id, statusRank: { $lt: ceiling } },
          update: {
            $set: {
              status: update.status,
              statusRank: rank,
              [`${update.status}At`]: update.at,
              ...(update.error === undefined ? {} : { error: update.error }),
              ...(update.pricing === undefined ? {} : { pricing: update.pricing }),
            },
          },
        },
      });
      ops.push({
        updateOne: {
          filter: { _id, providerMessageId: { $exists: false } },
          update: { $set: { providerMessageId: update.wamid } },
        },
      });
    }
    if (ops.length > 0) await this.model.bulkWrite(ops, { ordered: false });
  }

  /** Phones among `phones` that got a campaign message accepted by Meta since `since` (the frequency cap). */
  async recentlyMessaged(phones: readonly string[], since: Date): Promise<Set<string>> {
    if (phones.length === 0) return new Set();
    const found = await this.model
      .find(
        {
          to: { $in: [...phones] },
          createdAt: { $gte: since },
          'source.kind': 'campaign',
          status: { $in: ['accepted', 'sent', 'delivered', 'read'] },
        },
        { to: 1 },
      )
      .lean<{ to: string }[]>()
      .exec();
    return new Set(found.map((d) => d.to));
  }

  async countCampaign(campaignId: string): Promise<number> {
    return this.model.countDocuments({ campaignId: new Types.ObjectId(campaignId) }).exec();
  }

  /** Recipients of a campaign by what happened to their message, for retargeting. */
  async *campaignRecipients(
    campaignId: string,
    outcome: 'delivered_not_read' | 'read_no_reply' | 'replied' | 'button' | 'failed' | 'not_delivered',
    button?: string,
  ): AsyncGenerator<{ to: string; name?: string; userId?: string }> {
    const base = { campaignId: new Types.ObjectId(campaignId) };
    const filters = {
      delivered_not_read: { status: 'delivered' },
      read_no_reply: { status: 'read', reply: { $exists: false } },
      replied: { reply: { $exists: true } },
      button: { 'reply.lastButton': button ?? '' },
      failed: { status: 'failed' },
      not_delivered: { status: { $in: ['accepted', 'sent'] } },
    } as const;
    const cursor = this.model
      .find({ ...base, ...filters[outcome] }, { to: 1, name: 1, userId: 1 })
      .sort({ seq: 1 })
      .lean<{ to: string; name?: string; userId?: string }>()
      .cursor({ batchSize: 1000 });
    for await (const doc of cursor) {
      yield {
        to: doc.to,
        ...(doc.name === undefined ? {} : { name: doc.name }),
        ...(doc.userId === undefined ? {} : { userId: doc.userId }),
      };
    }
  }
}
