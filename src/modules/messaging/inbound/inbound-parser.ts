import { z } from 'zod';
import { normalizePhone } from '../whatsapp/phone.js';

/** One message a customer sent, read from Meta's webhook. */
export interface ParsedInbound {
  readonly wamid: string;
  readonly from: string;
  readonly name?: string;
  readonly type: string;
  readonly at: Date;
  readonly text?: string;
  /** A tapped button: quick replies (`button`) and interactive replies. */
  readonly button?: { readonly text: string; readonly payload?: string };
  readonly media?: { readonly id: string; readonly mime?: string };
  /** The wamid of our message it replies to. */
  readonly contextWamid?: string;
}

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;

// Third-party payload: unknown keys are kept (R5).
const reply = z.looseObject({ id: z.string().optional(), title: z.string() });
const messageSchema = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().regex(/^\d+$/),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  button: z.looseObject({ text: z.string(), payload: z.string().optional() }).optional(),
  interactive: z.looseObject({ button_reply: reply.optional(), list_reply: reply.optional() }).optional(),
  context: z.looseObject({ id: z.string().optional() }).optional(),
});
const media = z.looseObject({ id: z.string(), mime_type: z.string().optional() });
const contactsSchema = z.array(
  z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string().optional() }).optional() }),
);

/** The inbound messages of one webhook change; malformed ones and invalid phones are dropped. */
export function parseInbound(value: Readonly<Record<string, unknown>>): ParsedInbound[] {
  const contacts = contactsSchema.safeParse(value['contacts']);
  const names = new Map((contacts.success ? contacts.data : []).map((c) => [c.wa_id, c.profile?.name]));
  const list = Array.isArray(value['messages']) ? (value['messages'] as unknown[]) : [];
  const parsed: ParsedInbound[] = [];
  for (const item of list) {
    const result = messageSchema.safeParse(item);
    if (!result.success) continue;
    const m = result.data;
    const from = normalizePhone(m.from);
    if (from === null) continue;
    const choice = m.interactive?.button_reply ?? m.interactive?.list_reply;
    const button =
      m.button !== undefined
        ? { text: m.button.text, ...(m.button.payload === undefined ? {} : { payload: m.button.payload }) }
        : choice !== undefined
          ? { text: choice.title, ...(choice.id === undefined ? {} : { payload: choice.id }) }
          : undefined;
    const mediaType = MEDIA_TYPES.find((type) => type === m.type);
    const mediaValue =
      mediaType === undefined ? undefined : media.safeParse((m as Record<string, unknown>)[mediaType]);
    const name = names.get(m.from);
    parsed.push({
      wamid: m.id,
      from,
      ...(name === undefined ? {} : { name }),
      type: m.type,
      at: new Date(Number(m.timestamp) * 1000),
      ...(m.text === undefined ? {} : { text: m.text.body }),
      ...(button === undefined ? {} : { button }),
      ...(mediaValue?.success === true
        ? {
            media: {
              id: mediaValue.data.id,
              ...(mediaValue.data.mime_type === undefined ? {} : { mime: mediaValue.data.mime_type }),
            },
          }
        : {}),
      ...(m.context?.id === undefined ? {} : { contextWamid: m.context.id }),
    });
  }
  return parsed;
}

/** What the inbox shows for a message: its text, the button tapped, or the kind of media. */
export function previewOf(message: ParsedInbound): string {
  return (message.text ?? message.button?.text ?? `[${message.type}]`).slice(0, 80);
}

/**
 * Whether a message opts its sender out: an opt-out word as the whole text (any case, spaces at the ends
 * ignored), or a button whose payload or text is an opt-out payload or word.
 */
export function isOptOut(
  message: ParsedInbound,
  optOut: { readonly keywords: readonly string[]; readonly payloads: readonly string[] },
): boolean {
  const words = new Set(optOut.keywords.map((k) => k.toUpperCase()));
  if (message.text !== undefined && words.has(message.text.trim().toUpperCase())) return true;
  if (message.button === undefined) return false;
  const { text, payload } = message.button;
  return (payload !== undefined && optOut.payloads.includes(payload)) || words.has(text.trim().toUpperCase());
}
