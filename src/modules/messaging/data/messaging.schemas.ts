import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';

// The smaller collections of the messaging module (docs/modules/messaging/data-model.md). Indexes come from
// migration 0002; deliveries have their own file.

export const COLLECTIONS = {
  accounts: 'wa_accounts',
  templates: 'templates',
  media: 'media',
  inbound: 'inbound_messages',
  conversations: 'conversations',
  suppressions: 'suppressions',
  unmatchedStatuses: 'unmatched_statuses',
} as const;

/** A WhatsApp number we send from. One today (`main`), seeded from config at start. */
@Schema({ collection: COLLECTIONS.accounts, versionKey: false })
export class WaAccount {
  @Prop({ type: String })
  _id!: string;

  @Prop({ required: true })
  wabaId!: string;

  @Prop({ required: true })
  phoneNumberId!: string;

  @Prop({ required: true })
  portfolioId!: string;

  @Prop({ type: String, required: true, enum: ['messages', 'marketing_messages'] })
  marketingEndpoint!: 'messages' | 'marketing_messages';

  @Prop({ required: true })
  maxMps!: number;

  @Prop()
  quality?: string;

  @Prop()
  messagingLimit?: string;

  @Prop({ type: String, required: true, enum: ['active', 'paused'] })
  status!: 'active' | 'paused';

  @Prop()
  pauseReason?: string;

  @Prop({ required: true })
  updatedAt!: Date;
}
export const WaAccountSchema = SchemaFactory.createForClass(WaAccount);

/** A Meta template, synced from the WhatsApp Business Account. `_id` is Meta's template ID. */
@Schema({ collection: COLLECTIONS.templates, versionKey: false })
export class Template {
  @Prop({ type: String })
  _id!: string;

  @Prop({ required: true })
  accountId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  language!: string;

  @Prop({ required: true })
  category!: string;

  @Prop({ required: true })
  status!: string;

  @Prop({ required: true })
  quality!: string;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  components!: unknown[];

  @Prop({ required: true })
  syncedAt!: Date;
}
export const TemplateSchema = SchemaFactory.createForClass(Template);

/** A header media file: stored in the blob store, uploaded to Meta (which keeps it 30 days). */
@Schema({ collection: COLLECTIONS.media, versionKey: false })
export class Media {
  @Prop({ required: true })
  blobKey!: string;

  @Prop({ required: true })
  mime!: string;

  @Prop({ required: true })
  size!: number;

  @Prop({ required: true })
  filename!: string;

  @Prop({ required: true })
  accountId!: string;

  @Prop()
  metaMediaId?: string;

  @Prop()
  uploadedToMetaAt?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed })
  createdBy?: { userId?: string; email?: string };

  @Prop({ required: true })
  createdAt!: Date;
}
export const MediaSchema = SchemaFactory.createForClass(Media);

/** One message a customer sent us. `_id` is its wamid, so a duplicate webhook stores nothing new. */
@Schema({ collection: COLLECTIONS.inbound, versionKey: false })
export class InboundMessage {
  @Prop({ type: String })
  _id!: string;

  @Prop({ required: true })
  accountId!: string;

  @Prop({ required: true })
  from!: string;

  @Prop()
  name?: string;

  @Prop({ required: true })
  type!: string;

  @Prop()
  text?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  button?: { text: string; payload?: string };

  @Prop({ type: MongooseSchema.Types.Mixed })
  media?: { id: string; mime?: string };

  /** The wamid of our message it replies to. */
  @Prop()
  contextWamid?: string;

  @Prop()
  deliveryId?: string;

  @Prop()
  campaignId?: string;

  @Prop({ required: true })
  receivedAt!: Date;
}
export const InboundMessageSchema = SchemaFactory.createForClass(InboundMessage);

/** The inbox entry for one phone: the latest message either way, and unread replies. */
@Schema({ collection: COLLECTIONS.conversations, versionKey: false })
export class Conversation {
  @Prop({ type: String })
  _id!: string;

  @Prop({ required: true })
  accountId!: string;

  @Prop({ required: true })
  lastMessageAt!: Date;

  @Prop()
  lastInboundAt?: Date;

  @Prop({ type: String, required: true, enum: ['inbound', 'outbound'] })
  lastDirection!: 'inbound' | 'outbound';

  @Prop()
  lastPreview?: string;

  @Prop({ required: true, default: 0 })
  unread!: number;

  @Prop()
  name?: string;
}
export const ConversationSchema = SchemaFactory.createForClass(Conversation);

/** A phone that must not get marketing messages. `_id` is the phone. Kept indefinitely. */
@Schema({ collection: COLLECTIONS.suppressions, versionKey: false })
export class Suppression {
  @Prop({ type: String })
  _id!: string;

  @Prop({ type: String, required: true, enum: ['keyword', 'button', 'admin', 'import'] })
  reason!: 'keyword' | 'button' | 'admin' | 'import';

  /** What caused it: the inbound wamid, or the admin action. */
  @Prop()
  source?: string;

  @Prop()
  by?: string;

  @Prop({ required: true })
  createdAt!: Date;
}
export const SuppressionSchema = SchemaFactory.createForClass(Suppression);

/** A status we couldn't match to a delivery (old v1 messages, storefront messages). Expires after 7 days. */
@Schema({ collection: COLLECTIONS.unmatchedStatuses, versionKey: false })
export class UnmatchedStatus {
  @Prop({ required: true })
  wamid!: string;

  @Prop()
  phoneNumberId?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  status!: Record<string, unknown>;

  @Prop({ required: true })
  receivedAt!: Date;

  @Prop({ required: true })
  expireAt!: Date;
}
export const UnmatchedStatusSchema = SchemaFactory.createForClass(UnmatchedStatus);
