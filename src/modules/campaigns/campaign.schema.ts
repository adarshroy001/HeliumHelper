import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type Types } from 'mongoose';
import type { TemplatePayload } from '../messaging/index.js';
import type {
  CampaignAudience,
  CampaignAutoReply,
  CampaignMapping,
  CampaignOptions,
} from './campaigns.schemas.js';

/** Collection names; their indexes come from migration 0003. */
export const CAMPAIGNS_COLLECTION = 'campaigns';
export const UPLOADS_COLLECTION = 'uploads';

export const CAMPAIGN_STATUSES = [
  'draft',
  'building',
  'ready',
  'build_failed',
  'scheduled',
  'sending',
  'paused',
  'send_complete',
  'stopped',
  'closed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** The template as it was when the campaign was created. */
export interface TemplateSnapshot {
  readonly templateId: string;
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly components: readonly Record<string, unknown>[];
}

export interface CampaignTotals {
  readonly total: number;
  readonly skipped: Readonly<
    Record<'invalid' | 'suppressed' | 'duplicate' | 'frequency' | 'excluded', number>
  >;
}

/** A WhatsApp campaign (docs/modules/messaging/data-model.md#campaigns). */
// minimize: false keeps empty objects (a source with no filters is `filters: {}`), so audiences read back as written.
@Schema({ collection: CAMPAIGNS_COLLECTION, versionKey: false, minimize: false })
export class Campaign {
  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  accountId!: string;

  @Prop({ type: String, required: true, enum: CAMPAIGN_STATUSES })
  status!: CampaignStatus;

  /** Bumped on every change, so two commands never both apply. */
  @Prop({ required: true, default: 0 })
  version!: number;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  template!: TemplateSnapshot;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  variableMapping!: CampaignMapping[];

  @Prop({ type: MongooseSchema.Types.Mixed })
  headerMedia?: { type: 'image' | 'video' | 'document'; mediaId: string };

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  audience!: CampaignAudience;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  options!: CampaignOptions;

  @Prop({ type: MongooseSchema.Types.Mixed })
  autoReply?: CampaignAutoReply;

  @Prop({ type: MongooseSchema.Types.Mixed })
  schedule?: { at: Date };

  @Prop({ type: MongooseSchema.Types.Mixed })
  build?: { seq: number; processed: number; heartbeatAt?: Date; error?: string };

  @Prop({ type: MongooseSchema.Types.Mixed })
  feed?: { cursor: number; exhausted: boolean };

  @Prop({ type: MongooseSchema.Types.Mixed })
  totals?: CampaignTotals;

  /** The send message's fixed parts, built once at start (endpoint, template with header media). */
  @Prop({ type: MongooseSchema.Types.Mixed })
  send?: { endpoint: 'messages' | 'marketing_messages'; phoneNumberId: string; template: TemplatePayload };

  @Prop()
  pauseReason?: string;

  @Prop()
  stopReason?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  countsSnapshot?: Record<string, number>;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  createdBy!: { service: string; userId?: string; email?: string };

  @Prop({ required: true })
  createdAt!: Date;

  @Prop({ required: true })
  updatedAt!: Date;

  @Prop()
  builtAt?: Date;

  @Prop()
  sendStartedAt?: Date;

  @Prop()
  sendCompletedAt?: Date;

  @Prop()
  stoppedAt?: Date;

  @Prop()
  closedAt?: Date;

  /** When a stopped campaign's never-sent deliveries were skipped. */
  @Prop()
  finalizedAt?: Date;
}
export const CampaignSchema = SchemaFactory.createForClass(Campaign);
export type CampaignDocument = Omit<Campaign, never> & { _id: Types.ObjectId };

/** An uploaded CSV audience or exclusion list, stored in the blob store. */
@Schema({ collection: UPLOADS_COLLECTION, versionKey: false })
export class CsvUpload {
  @Prop({ required: true })
  blobKey!: string;

  @Prop({ required: true })
  filename!: string;

  @Prop({ required: true })
  size!: number;

  /** Data rows, without the header. */
  @Prop({ required: true })
  rows!: number;

  @Prop({ type: [String], required: true })
  columns!: string[];

  /** The column holding phone numbers. */
  @Prop({ required: true })
  phoneColumn!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  createdBy!: { service: string; userId?: string; email?: string };

  @Prop({ required: true })
  createdAt!: Date;
}
export const CsvUploadSchema = SchemaFactory.createForClass(CsvUpload);
export type CsvUploadDocument = Omit<CsvUpload, never> & { _id: Types.ObjectId };
