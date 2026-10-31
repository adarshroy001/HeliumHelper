import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import type { Actor } from '../../../common/auth/index.js';
import { BlobStore } from '../../../infrastructure/blob/index.js';
import { DB } from '../../../infrastructure/database/index.js';
import { QueuePublisher } from '../../../infrastructure/queue/index.js';
import { DeliveryLedger } from '../../messaging/index.js';
import { CampaignExport, type CampaignExportDocument } from '../campaign.schema.js';
import { ExportNotFoundError } from '../campaigns.errors.js';
import { CAMPAIGN_CONTROL_QUEUE, campaignCommand } from '../control/campaign-control.js';

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** HeliumAdmin's export columns, plus pricing and the wamid. */
const COLUMNS = [
  'phone',
  'name',
  'status',
  'sent_at',
  'delivered_at',
  'read_at',
  'failed_at',
  'error_code',
  'error',
  'skip_reason',
  'replies',
  'first_reply_at',
  'last_reply_at',
  'last_button',
  'pricing_category',
  'wamid',
];

function cell(value: unknown): string {
  const text =
    value instanceof Date
      ? value.toISOString()
      : value === undefined || value === null
        ? ''
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Campaign exports: requested by the API, written by the control consumer, downloaded as CSV. */
@Injectable()
export class CampaignExportsService {
  constructor(
    @InjectModel(CampaignExport.name, DB.messaging) private readonly model: Model<CampaignExport>,
    private readonly ledger: DeliveryLedger,
    private readonly blobs: BlobStore,
    private readonly publisher: QueuePublisher,
  ) {}

  async request(campaignId: string, actor: Actor): Promise<CampaignExportDocument> {
    const now = new Date();
    const [created] = await this.model.create([
      {
        campaignId,
        status: 'queued',
        requestedBy: {
          service: actor.service,
          ...(actor.user === undefined ? {} : { userId: actor.user.id, email: actor.user.email }),
        },
        createdAt: now,
        expireAt: new Date(now.getTime() + KEEP_MS),
      },
    ]);
    if (created === undefined) throw new RangeError('export was not created');
    await this.publisher.publish(CAMPAIGN_CONTROL_QUEUE, campaignCommand, {
      command: 'export',
      exportId: String(created._id),
    });
    return created.toObject<CampaignExportDocument>();
  }

  async get(id: string): Promise<CampaignExportDocument> {
    const found = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).lean<CampaignExportDocument>().exec()
      : null;
    if (found === null) throw new ExportNotFoundError(id);
    return found;
  }

  /** The finished file, streamed. */
  async file(id: string): Promise<{ stream: Readable; filename: string }> {
    const found = await this.get(id);
    if (found.status !== 'done' || found.blobKey === undefined) throw new ExportNotFoundError(id);
    return { stream: this.blobs.open(found.blobKey), filename: `campaign-${found.campaignId}.csv` };
  }

  /** Writes the CSV row by row from a cursor, so a million recipients never sit in memory. */
  async run(id: string): Promise<void> {
    const found = await this.model
      .findOneAndUpdate(
        { _id: id, status: { $in: ['queued', 'running'] } },
        { $set: { status: 'running' } },
        { returnDocument: 'after' },
      )
      .lean<CampaignExportDocument>()
      .exec();
    if (found === null) return;
    let rows = 0;
    const ledger = this.ledger;
    const lines = async function* () {
      yield `\uFEFF${COLUMNS.join(',')}\n`;
      for await (const d of ledger.campaignCursor(found.campaignId)) {
        rows += 1;
        yield `${[
          d.to,
          d.name,
          d.status,
          d.sentAt,
          d.deliveredAt,
          d.readAt,
          d.failedAt,
          d.error?.code,
          d.error?.title,
          d.skipReason,
          d.reply?.count,
          d.reply?.firstAt,
          d.reply?.lastAt,
          d.reply?.lastButton,
          d.pricing?.category,
          d.providerMessageId,
        ]
          .map(cell)
          .join(',')}\n`;
      }
    };
    const blobKey = `exports/${id}.csv`;
    try {
      await this.blobs.put(blobKey, Readable.from(lines()));
      await this.model
        .updateOne({ _id: id }, { $set: { status: 'done', blobKey, rows, finishedAt: new Date() } })
        .exec();
    } catch (error) {
      await this.model
        .updateOne(
          { _id: id },
          { $set: { status: 'failed', error: error instanceof Error ? error.message : 'failed' } },
        )
        .exec();
      throw error;
    }
  }
}
