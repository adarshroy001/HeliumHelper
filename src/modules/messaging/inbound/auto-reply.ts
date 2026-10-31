import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DeliveryPayload } from '../data/delivery.schema.js';
import type { ParsedInbound } from './inbound-parser.js';

/**
 * A campaign's auto-reply (HeliumAdmin's shape), published to Redis by the campaign lifecycle when it starts
 * (`wa:autoreply:{campaignId}`) so the inbound consumer never reads campaign documents.
 */
export const autoReplyRuleSchema = z.strictObject({
  trigger: z.enum(['any_button', 'any_reply']),
  mode: z.enum(['text', 'template']),
  text: z.string().max(4096).optional(),
  template: z.strictObject({ name: z.string().min(1), language: z.string().min(2) }).optional(),
  choiceReplies: z
    .array(z.strictObject({ buttonText: z.string(), replyText: z.string().max(4096) }))
    .optional(),
});
export type AutoReplyRule = z.infer<typeof autoReplyRuleSchema>;

/** Replies to messages older than this are not sent: after an outage, people aren't answered hours late. */
export const AUTO_REPLY_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * The reply to send for a message, or `null` when the rule doesn't apply. A per-button text wins over the general
 * text; `{{name}}` and `{{phone}}` are filled in, as in HeliumAdmin.
 */
export function autoReplyFor(
  rule: AutoReplyRule,
  message: ParsedInbound,
  recipient: { readonly name?: string; readonly phone: string },
): DeliveryPayload | null {
  if (rule.trigger === 'any_button' && message.button === undefined) return null;
  if (rule.mode === 'template') {
    return rule.template === undefined
      ? null
      : {
          kind: 'template',
          template: { name: rule.template.name, language: { code: rule.template.language } },
        };
  }
  const tapped = message.button?.text.trim().toLowerCase();
  const choice = rule.choiceReplies?.find(
    (c) => tapped !== undefined && c.buttonText.trim().toLowerCase() === tapped,
  );
  const text = (choice?.replyText ?? rule.text ?? '').trim();
  if (text === '') return null;
  return {
    kind: 'text',
    text: text
      .replaceAll('{{name}}', recipient.name?.trim() || 'there')
      .replaceAll('{{phone}}', recipient.phone),
  };
}

/** The auto-reply's delivery ID: derived from the campaign delivery, so a recipient gets at most one. */
export function autoReplyId(campaignDeliveryId: string): string {
  return `ar-${createHash('sha256').update(campaignDeliveryId).digest('hex').slice(0, 24)}`;
}
