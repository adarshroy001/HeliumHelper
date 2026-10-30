import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';

/** Collection name; its indexes come from migration 0001. */
export const AUDIT_COLLECTION = 'audit_log';

/** One state-changing action: who did what to which entity, which fields changed, in which request. */
@Schema({ collection: AUDIT_COLLECTION, versionKey: false })
export class AuditEntry {
  /** The calling service, and the admin user it acted for, if any. */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  actor!: { service: string; userId?: string; email?: string };

  /** `{entity}.{verb}`, such as `campaign.start`. */
  @Prop({ required: true })
  action!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  entity!: { type: string; id: string };

  /** Only the fields that changed, each as `{ from, to }`. Absent for actions that change no fields. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  changes?: Record<string, { from: unknown; to: unknown }>;

  /** The request (or message correlation ID) the action happened in, to join with the logs. */
  @Prop({ required: true })
  requestId!: string;

  @Prop({ required: true })
  at!: Date;
}

export const AuditEntrySchema = SchemaFactory.createForClass(AuditEntry);
