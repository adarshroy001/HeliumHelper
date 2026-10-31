import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type Types } from 'mongoose';
import type { TemplatePayload } from '../whatsapp/template.js';

/** Collection name; its indexes come from migration 0002. */
export const DELIVERIES_COLLECTION = 'deliveries';

export const DELIVERY_STATUSES = [
  'pending',
  'accepted',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Ranks for status transitions (docs/modules/messaging/design.md#ranks-and-counters). A status applies only over
 * a lower rank. `failed` and `skipped` are terminal: `failed` applies below `delivered`, `skipped` only from
 * `pending`.
 */
export const STATUS_RANK: Readonly<Record<DeliveryStatus, number>> = {
  pending: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 9,
  skipped: 9,
};

export type DeliverySource = 'campaign' | 'direct' | 'auto_reply' | 'test';

export type DeliveryPayload =
  | { readonly kind: 'template'; readonly template: TemplatePayload }
  | { readonly kind: 'text'; readonly text: string };

export interface DeliveryError {
  readonly code?: number;
  readonly title: string;
  readonly at: Date;
}

/** One outbound WhatsApp message, whatever sent it (ADR-0015). */
@Schema({ collection: DELIVERIES_COLLECTION, versionKey: false })
export class Delivery {
  /** An ObjectId, or a deterministic string for auto-replies; always set by the code that inserts it. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  _id!: Types.ObjectId | string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  source!: { kind: DeliverySource; id?: string };

  @Prop({ type: MongooseSchema.Types.ObjectId })
  campaignId?: Types.ObjectId;

  /** Order within a campaign, for feeding and paging. */
  @Prop()
  seq?: number;

  /** `<campaignId>:<phone>`, unique: one delivery per recipient per campaign. */
  @Prop()
  dedupeKey?: string;

  @Prop({ required: true })
  accountId!: string;

  /** `91` + 10 digits. */
  @Prop({ required: true })
  to!: string;

  @Prop()
  userId?: string;

  @Prop()
  name?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload!: DeliveryPayload;

  @Prop({ type: String, required: true, enum: DELIVERY_STATUSES })
  status!: DeliveryStatus;

  @Prop({ required: true })
  statusRank!: number;

  /** Meta's wamid, once accepted. */
  @Prop()
  providerMessageId?: string;

  @Prop()
  acceptedAt?: Date;

  @Prop()
  sentAt?: Date;

  @Prop()
  deliveredAt?: Date;

  @Prop()
  readAt?: Date;

  @Prop()
  failedAt?: Date;

  @Prop()
  skippedAt?: Date;

  @Prop()
  skipReason?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  error?: DeliveryError;

  /** Re-fed once after an unknown send result (design.md#unknown-results). */
  @Prop()
  unconfirmedRetry?: boolean;

  @Prop({ type: MongooseSchema.Types.Mixed })
  pricing?: { category?: string; billable?: boolean };

  @Prop({ type: MongooseSchema.Types.Mixed })
  reply?: { firstAt: Date; lastAt: Date; count: number; lastButton?: string };

  @Prop({ required: true })
  createdAt!: Date;
}

export const DeliverySchema = SchemaFactory.createForClass(Delivery);
