import { z } from 'zod';
import { paginationQuery } from '../../common/validation/index.js';

// Request schemas of the campaigns routes (docs/modules/messaging/api.md). Audience and mapping shapes follow
// HeliumAdmin's, so its composer can move over unchanged.

export const objectId = z.string().regex(/^[a-f\d]{24}$/, 'Must be an ID.');
const day = z.iso.date('Must be a date like 2026-10-31.');
const list = z.array(z.string().min(1).max(100)).max(50);
const money = z.number().min(0).max(10_000_000);

export const mappingSchema = z.strictObject({
  index: z.number().int().min(1).max(50),
  component: z.enum(['HEADER', 'BODY', 'BUTTONS']),
  buttonIndex: z.number().int().min(0).max(9).optional(),
  source: z.enum(['field', 'static']),
  value: z.string().max(1000),
});
export type CampaignMapping = z.infer<typeof mappingSchema>;

const sourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('users'),
    filters: z.strictObject({ registeredFrom: day.optional(), registeredTo: day.optional() }),
  }),
  z.strictObject({
    type: z.literal('orders'),
    filters: z.strictObject({
      orderDateFrom: day.optional(),
      orderDateTo: day.optional(),
      status: list.optional(),
      paymentStatus: list.optional(),
      paymentMethod: list.optional(),
      channel: list.optional(),
      minOrderValue: money.optional(),
      maxOrderValue: money.optional(),
      productModel: list.optional(),
      deliveryPartner: list.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal('abandoned_carts'),
    filters: z.strictObject({
      cartDateFrom: day.optional(),
      cartDateTo: day.optional(),
      includeRecovered: z.boolean().optional(),
      minCartValue: money.optional(),
      productTitle: z.string().max(100).optional(),
      utmSource: list.optional(),
    }),
  }),
  z.strictObject({
    type: z.literal('waitlist'),
    filters: z.strictObject({
      joinedFrom: day.optional(),
      joinedTo: day.optional(),
      source: list.optional(),
    }),
  }),
]);
export type AudienceSource = z.infer<typeof sourceSchema>;

export const RETARGET_OUTCOMES = [
  'delivered_not_read',
  'read_no_reply',
  'replied',
  'button',
  'failed',
  'not_delivered',
] as const;

export const audienceSchema = z.strictObject({
  sources: z.array(sourceSchema).max(4).default([]),
  individual: z
    .array(
      z.strictObject({
        phone: z.string().min(10).max(20),
        name: z.string().max(100),
        email: z.string().max(200).optional(),
      }),
    )
    .max(1000)
    .default([]),
  csvUploadId: objectId.optional(),
  exclusions: z
    .strictObject({
      phones: z.array(z.string().min(10).max(20)).max(10_000).optional(),
      uploadId: objectId.optional(),
    })
    .optional(),
  /** Recipients of an earlier campaign, by what happened to their message. */
  retarget: z
    .strictObject({
      campaignId: objectId,
      outcome: z.enum(RETARGET_OUTCOMES),
      button: z.string().max(100).optional(),
    })
    .optional(),
});
export type CampaignAudience = z.infer<typeof audienceSchema>;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a time like 21:00.');

export const optionsSchema = z.strictObject({
  /** Skip people who got a marketing message from us within this many hours. 0 turns it off. */
  frequencyCapHours: z.number().int().min(0).max(720).default(24),
  /** Send only between these times, India time. */
  sendWindow: z.strictObject({ start: time, end: time }).optional(),
  /** This campaign's most messages per second. */
  maxMps: z.number().int().min(1).max(1000).optional(),
  /** Orders placed within this many days of delivery count as conversions. */
  attributionDays: z.number().int().min(1).max(30).default(7),
});
export type CampaignOptions = z.infer<typeof optionsSchema>;

export const autoReplySchema = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(['text', 'template']),
  trigger: z.enum(['any_button', 'any_reply']),
  text: z.string().max(4096).optional(),
  templateId: z.string().min(1).max(40).optional(),
  choiceReplies: z
    .array(z.strictObject({ buttonText: z.string().min(1).max(100), replyText: z.string().min(1).max(4096) }))
    .max(10)
    .optional(),
});
export type CampaignAutoReply = z.infer<typeof autoReplySchema> & {
  template?: { name: string; language: string };
};

export const createCampaignSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  /** Meta's template ID, from `GET /templates`. */
  templateId: z.string().min(1).max(40),
  variableMapping: z.array(mappingSchema).max(50).default([]),
  /** From `POST /media`, when the template has a media header. */
  headerMediaId: objectId.optional(),
  audience: audienceSchema,
  options: optionsSchema.default({ frequencyCapHours: 24, attributionDays: 7 }),
  autoReply: autoReplySchema.optional(),
});
export type CreateCampaign = z.infer<typeof createCampaignSchema>;

/**
 * Every field optional and without defaults: a field left out keeps its value (`.partial()` would fill in the
 * create defaults and overwrite it). A field given replaces the whole value.
 */
export const updateCampaignSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  templateId: z.string().min(1).max(40).optional(),
  variableMapping: z.array(mappingSchema).max(50).optional(),
  headerMediaId: objectId.optional(),
  audience: audienceSchema.optional(),
  options: optionsSchema.optional(),
  autoReply: autoReplySchema.optional(),
});
export type UpdateCampaign = z.infer<typeof updateCampaignSchema>;

export const listCampaignsQuery = paginationQuery.extend({
  status: z
    .enum([
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
    ])
    .optional(),
});
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuery>;

export const previewAudienceSchema = z.strictObject({
  audience: audienceSchema,
  /** With a template and mapping, the preview includes one rendered sample message. */
  templateId: z.string().min(1).max(40).optional(),
  variableMapping: z.array(mappingSchema).max(50).default([]),
});
export type PreviewAudience = z.infer<typeof previewAudienceSchema>;

/** Starting or scheduling more than 100,000 recipients needs the count typed back. */
export const startCampaignSchema = z.strictObject({ confirmTotal: z.number().int().min(0).optional() });
export type StartCampaign = z.infer<typeof startCampaignSchema>;

export const scheduleCampaignSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  confirmTotal: z.number().int().min(0).optional(),
});
export type ScheduleCampaign = z.infer<typeof scheduleCampaignSchema>;

export const stopCampaignSchema = z.strictObject({ reason: z.string().trim().min(1).max(200).optional() });
export type StopCampaign = z.infer<typeof stopCampaignSchema>;

export const testCampaignSchema = z.strictObject({
  phones: z.array(z.string().min(10).max(20)).min(1).max(5),
});
export type TestCampaign = z.infer<typeof testCampaignSchema>;
