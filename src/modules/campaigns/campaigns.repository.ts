import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Model, type QueryFilter, Types } from 'mongoose';
import { DB, findPage, type Page, type PageRequest } from '../../infrastructure/database/index.js';
import {
  Campaign,
  type CampaignDocument,
  type CampaignStatus,
  CsvUpload,
  type CsvUploadDocument,
} from './campaign.schema.js';

/** The only code that writes `campaigns`. State changes are conditional on the current status and version. */
@Injectable()
export class CampaignsRepository {
  constructor(@InjectModel(Campaign.name, DB.messaging) private readonly model: Model<Campaign>) {}

  async create(
    campaign: Omit<Campaign, 'version' | 'createdAt' | 'updatedAt'>,
    session?: ClientSession,
  ): Promise<CampaignDocument> {
    const now = new Date();
    const [created] = await this.model.create([{ ...campaign, version: 0, createdAt: now, updatedAt: now }], {
      session,
    });
    if (created === undefined) throw new RangeError('campaign was not created');
    return created.toObject<CampaignDocument>();
  }

  async findById(id: string): Promise<CampaignDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.model.findById(id).lean<CampaignDocument>().exec();
  }

  async list(filter: { status?: CampaignStatus }, page: PageRequest): Promise<Page<CampaignDocument>> {
    const query: QueryFilter<Campaign> = filter.status === undefined ? {} : { status: filter.status };
    return findPage(this.model, query, page);
  }

  /**
   * Applies `set` (and `unset`) only if the campaign is still in one of `from` at `version`; bumps the version.
   * Returns the updated campaign, or `null` when someone else changed it first.
   */
  async transition(
    id: string,
    expected: { from: readonly CampaignStatus[]; version?: number },
    set: Partial<Campaign>,
    options: { unset?: readonly (keyof Campaign)[]; session?: ClientSession } = {},
  ): Promise<CampaignDocument | null> {
    return this.model
      .findOneAndUpdate(
        {
          _id: id,
          status: { $in: [...expected.from] },
          ...(expected.version === undefined ? {} : { version: expected.version }),
        },
        {
          $set: { ...set, updatedAt: new Date() },
          $inc: { version: 1 },
          ...(options.unset === undefined || options.unset.length === 0
            ? {}
            : { $unset: Object.fromEntries(options.unset.map((field) => [field, 1])) }),
        },
        { returnDocument: 'after', session: options.session },
      )
      .lean<CampaignDocument>()
      .exec();
  }

  /** Reserves `count` sequence numbers for a building campaign; returns the first. Numbers are never reused. */
  async reserveSeq(id: string, count: number): Promise<number> {
    const updated = await this.model
      .findOneAndUpdate(
        { _id: id },
        { $inc: { 'build.seq': count } },
        { returnDocument: 'after', projection: { build: 1 } },
      )
      .lean<{ build?: { seq: number } }>()
      .exec();
    return (updated?.build?.seq ?? count) - count;
  }

  /** Records a running build's progress; the sweeper re-queues a build whose heartbeat stops. */
  async heartbeat(id: string, processed: number): Promise<void> {
    await this.model
      .updateOne(
        { _id: id, status: 'building' },
        { $set: { 'build.processed': processed, 'build.heartbeatAt': new Date() } },
      )
      .exec();
  }

  /** Scheduled campaigns whose time has come. */
  async findDue(now: Date, limit = 50): Promise<CampaignDocument[]> {
    return this.model
      .find({ status: 'scheduled', 'schedule.at': { $lte: now } })
      .limit(limit)
      .lean<CampaignDocument[]>()
      .exec();
  }

  /** Builds whose heartbeat stopped before `before` (a crashed or lost build). */
  async findStuckBuilds(before: Date): Promise<CampaignDocument[]> {
    return this.model
      .find({ status: 'building', 'build.heartbeatAt': { $lt: before } })
      .lean<CampaignDocument[]>()
      .exec();
  }

  /** Stopped campaigns whose never-sent deliveries haven't been skipped yet. */
  async findStoppedUnfinalized(): Promise<CampaignDocument[]> {
    return this.model
      .find({ status: 'stopped', finalizedAt: { $exists: false } })
      .lean<CampaignDocument[]>()
      .exec();
  }

  /** Finished campaigns old enough to close. */
  async findClosable(before: Date): Promise<CampaignDocument[]> {
    return this.model
      .find({
        $or: [
          { status: 'send_complete', sendCompletedAt: { $lt: before } },
          { status: 'stopped', finalizedAt: { $exists: true }, stoppedAt: { $lt: before } },
        ],
      })
      .lean<CampaignDocument[]>()
      .exec();
  }

  async findByIds(ids: readonly string[]): Promise<CampaignDocument[]> {
    return this.model
      .find({ _id: { $in: ids.filter((id) => Types.ObjectId.isValid(id)) } })
      .lean<CampaignDocument[]>()
      .exec();
  }

  async delete(id: string, version: number, session?: ClientSession): Promise<boolean> {
    const result = await this.model.deleteOne({ _id: id, status: 'draft', version }, { session }).exec();
    return result.deletedCount === 1;
  }
}

/** The only code that writes `uploads`. */
@Injectable()
export class UploadsRepository {
  constructor(@InjectModel(CsvUpload.name, DB.messaging) private readonly model: Model<CsvUpload>) {}

  async create(upload: Omit<CsvUpload, 'createdAt'>): Promise<CsvUploadDocument> {
    const [created] = await this.model.create([{ ...upload, createdAt: new Date() }]);
    if (created === undefined) throw new RangeError('upload was not created');
    return created.toObject<CsvUploadDocument>();
  }

  async findById(id: string): Promise<CsvUploadDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.model.findById(id).lean<CsvUploadDocument>().exec();
  }
}
