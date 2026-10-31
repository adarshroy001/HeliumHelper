import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, mongo } from 'mongoose';
import { DB } from '../../../infrastructure/database/index.js';
import { duplicateKeyIndexes } from './duplicate-keys.js';
import {
  Conversation,
  InboundMessage,
  Suppression,
  Template,
  UnmatchedStatus,
  WaAccount,
} from './messaging.schemas.js';

/** The only code that writes `wa_accounts`. */
@Injectable()
export class AccountsRepository {
  constructor(@InjectModel(WaAccount.name, DB.messaging) private readonly model: Model<WaAccount>) {}

  /**
   * Creates or refreshes an account from config. Its pause state, quality and limit are kept: they come from
   * Meta's events, not from config.
   */
  async upsertFromConfig(
    account: Pick<
      WaAccount,
      '_id' | 'wabaId' | 'phoneNumberId' | 'portfolioId' | 'marketingEndpoint' | 'maxMps'
    >,
  ): Promise<void> {
    const { _id, ...fields } = account;
    await this.model
      .updateOne(
        { _id },
        { $set: { ...fields, updatedAt: new Date() }, $setOnInsert: { status: 'active' } },
        { upsert: true },
      )
      .exec();
  }

  async findById(id: string): Promise<WaAccount | null> {
    return this.model.findById(id).lean<WaAccount>().exec();
  }

  async findAll(): Promise<WaAccount[]> {
    return this.model.find().lean<WaAccount[]>().exec();
  }

  async setStatus(id: string, status: 'active' | 'paused', pauseReason?: string): Promise<void> {
    const update =
      status === 'paused'
        ? { $set: { status, pauseReason, updatedAt: new Date() } }
        : { $set: { status, updatedAt: new Date() }, $unset: { pauseReason: 1 } };
    await this.model.updateOne({ _id: id }, update).exec();
  }

  async setHealth(id: string, health: { quality?: string; messagingLimit?: string }): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { ...health, updatedAt: new Date() } }).exec();
  }
}

/** The only code that writes `inbound_messages`. */
@Injectable()
export class InboundMessagesRepository {
  constructor(
    @InjectModel(InboundMessage.name, DB.messaging) private readonly model: Model<InboundMessage>,
  ) {}

  /** A campaign's replies, newest first, before `before`. */
  async campaignReplies(
    campaignId: string,
    before: Date | undefined,
    limit: number,
  ): Promise<InboundMessage[]> {
    return this.model
      .find({ campaignId, ...(before === undefined ? {} : { receivedAt: { $lt: before } }) })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .lean<InboundMessage[]>()
      .exec();
  }

  /** Inserts messages by wamid; returns the wamids that were new. A duplicate webhook stores nothing. */
  async insertNew(messages: readonly InboundMessage[]): Promise<Set<string>> {
    if (messages.length === 0) return new Set();
    const fresh = new Set(messages.map((m) => m._id));
    try {
      await this.model.collection.insertMany(messages as unknown as mongo.OptionalId<mongo.Document>[], {
        ordered: false,
      });
    } catch (error) {
      const duplicates = duplicateKeyIndexes(error);
      if (duplicates === null) throw error;
      for (const index of duplicates) {
        const id = messages[index]?._id;
        if (id !== undefined) fresh.delete(id);
      }
    }
    return fresh;
  }
}

/** The only code that writes `conversations`. */
@Injectable()
export class ConversationsRepository {
  constructor(@InjectModel(Conversation.name, DB.messaging) private readonly model: Model<Conversation>) {}

  /** Records the latest message of each conversation, in one round trip. Inbound messages add to `unread`. */
  async record(
    events: readonly {
      phone: string;
      accountId: string;
      direction: 'inbound' | 'outbound';
      at: Date;
      preview?: string;
      name?: string;
    }[],
  ): Promise<void> {
    if (events.length === 0) return;
    await this.model.bulkWrite(
      events.map((event) => ({
        updateOne: {
          filter: { _id: event.phone },
          update: {
            $max: {
              lastMessageAt: event.at,
              ...(event.direction === 'inbound' ? { lastInboundAt: event.at } : {}),
            },
            $set: {
              accountId: event.accountId,
              lastDirection: event.direction,
              ...(event.preview === undefined ? {} : { lastPreview: event.preview.slice(0, 80) }),
              ...(event.name === undefined ? {} : { name: event.name }),
            },
            $inc: { unread: event.direction === 'inbound' ? 1 : 0 },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async markRead(phone: string): Promise<void> {
    await this.model.updateOne({ _id: phone }, { $set: { unread: 0 } }).exec();
  }
}

/** The only code that writes `suppressions`. */
@Injectable()
export class SuppressionsRepository {
  constructor(@InjectModel(Suppression.name, DB.messaging) private readonly model: Model<Suppression>) {}

  /** Adds phones; an existing suppression keeps its original reason and time. Returns how many were new. */
  async add(entries: readonly Omit<Suppression, 'createdAt'>[]): Promise<number> {
    if (entries.length === 0) return 0;
    const now = new Date();
    const result = await this.model.bulkWrite(
      entries.map(({ _id, ...rest }) => ({
        updateOne: { filter: { _id }, update: { $setOnInsert: { ...rest, createdAt: now } }, upsert: true },
      })),
      { ordered: false },
    );
    return result.upsertedCount;
  }

  async remove(phone: string): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: phone }).exec();
    return result.deletedCount === 1;
  }

  /** Every suppressed phone, streamed, for reloading the Redis mirror. */
  async *allPhones(batchSize = 5000): AsyncGenerator<string[]> {
    let batch: string[] = [];
    for await (const doc of this.model.find({}, { _id: 1 }).lean<{ _id: string }>().cursor({ batchSize })) {
      batch.push(doc._id);
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }
}

/** The only code that writes `unmatched_statuses`. */
@Injectable()
export class UnmatchedStatusesRepository {
  constructor(
    @InjectModel(UnmatchedStatus.name, DB.messaging) private readonly model: Model<UnmatchedStatus>,
  ) {}

  async insertMany(statuses: readonly Omit<UnmatchedStatus, 'expireAt'>[]): Promise<void> {
    if (statuses.length === 0) return;
    const expireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.model.insertMany(
      statuses.map((s) => ({ ...s, expireAt })),
      { ordered: false },
    );
  }
}

/** The only code that writes `templates`: a mirror of Meta's templates, refreshed by sync and Meta's events. */
@Injectable()
export class TemplatesRepository {
  constructor(@InjectModel(Template.name, DB.messaging) private readonly model: Model<Template>) {}

  /** Makes the mirror match Meta: templates Meta no longer returns are removed, the rest upserted. */
  async replaceAll(
    accountId: string,
    templates: readonly Omit<Template, 'syncedAt' | 'accountId'>[],
  ): Promise<number> {
    const now = new Date();
    // Removed first: a template deleted and recreated with the same name gets a new ID.
    await this.model.deleteMany({ accountId, _id: { $nin: templates.map((t) => t._id) } }).exec();
    if (templates.length > 0) {
      await this.model.bulkWrite(
        templates.map(({ _id, ...fields }) => ({
          updateOne: {
            filter: { _id },
            update: { $set: { ...fields, accountId, syncedAt: now } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    return templates.length;
  }

  /** Applies one field Meta changed (status, quality or category); unknown templates wait for the next sync. */
  async update(
    id: string,
    fields: Partial<Pick<Template, 'status' | 'quality' | 'category'>>,
  ): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { ...fields, syncedAt: new Date() } }).exec();
  }

  async findById(id: string): Promise<Template | null> {
    return this.model.findById(id).lean<Template>().exec();
  }

  async find(accountId: string, name: string, language: string): Promise<Template | null> {
    return this.model.findOne({ accountId, name, language }).lean<Template>().exec();
  }

  async list(accountId: string, status?: string): Promise<Template[]> {
    return this.model
      .find({ accountId, ...(status === undefined ? {} : { status }) })
      .sort({ name: 1, language: 1 })
      .lean<Template[]>()
      .exec();
  }
}
