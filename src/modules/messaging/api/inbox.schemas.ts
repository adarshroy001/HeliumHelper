import { z } from 'zod';
import { queryBoolean, queryInt } from '../../../common/validation/index.js';
import { normalizePhone } from '../whatsapp/phone.js';

/** A phone in a path, normalized (`9876543210`, `+91 98765 43210`, `919876543210`). */
export const phoneParam = z.string().transform((value, ctx) => {
  const phone = normalizePhone(value);
  if (phone === null) {
    ctx.addIssue({ code: 'custom', message: 'Must be an Indian mobile number.' });
    return z.NEVER;
  }
  return phone;
});

const before = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v))
  .optional();
const limit = queryInt(z.number().int().min(1).max(100)).default(30);

export const conversationsQuery = z.strictObject({ unread: queryBoolean().default(false), before, limit });
export type ConversationsQuery = z.infer<typeof conversationsQuery>;

export const timelineQuery = z.strictObject({ before, limit });
export type TimelineQuery = z.infer<typeof timelineQuery>;

export const searchQuery = z.strictObject({ q: z.string().trim().min(2).max(100) });
export type SearchQuery = z.infer<typeof searchQuery>;

export const directMessageSchema = z.union([
  z.strictObject({ text: z.string().trim().min(1).max(4096) }),
  z.strictObject({
    template: z.strictObject({
      templateId: z.string().min(1).max(40),
      header: z.array(z.string().max(1000)).max(10).optional(),
      body: z.array(z.string().max(1000)).max(20).optional(),
      buttons: z
        .array(
          z.strictObject({
            index: z.number().int().min(0).max(9),
            parameters: z.array(z.string().max(1000)).max(5),
          }),
        )
        .max(10)
        .optional(),
      headerMediaId: z
        .string()
        .regex(/^[a-f\d]{24}$/)
        .optional(),
    }),
  }),
]);
export type DirectMessageBody = z.infer<typeof directMessageSchema>;

export const suppressionsQuery = z.strictObject({
  after: z
    .string()
    .regex(/^91\d{10}$/)
    .optional(),
  limit: queryInt(z.number().int().min(1).max(200)).default(50),
});
export type SuppressionsQuery = z.infer<typeof suppressionsQuery>;
