import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Meta's webhooks: the signature check and the splitter that routes each change to its queue
 * (docs/modules/messaging/design.md#webhooks). Plain TypeScript, shared by the API route and a future Lambda.
 */

/**
 * Whether `X-Hub-Signature-256` (`sha256=<hex>`) is the HMAC-SHA256 of the exact body bytes with one of the app
 * secrets (two while rotating). Compared in constant time.
 */
export function isValidSignature(
  rawBody: Buffer,
  header: string | undefined,
  secrets: readonly string[],
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? '');
  if (match?.[1] === undefined) return false;
  const given = Buffer.from(match[1].toLowerCase(), 'hex');
  return secrets.some((secret) =>
    timingSafeEqual(createHmac('sha256', secret).update(rawBody).digest(), given),
  );
}

export type WebhookRoute = 'status' | 'inbound' | 'account';

/** One change of a webhook, as queued for a consumer. */
export interface WebhookChange {
  readonly receivedAt: string;
  readonly wabaId: string;
  /** From `value.metadata`; account-level events have none. */
  readonly phoneNumberId?: string;
  readonly field: string;
  readonly value: Readonly<Record<string, unknown>>;
}

// Third-party payload: unknown keys are kept (R5).
const payloadSchema = z.looseObject({
  object: z.string(),
  entry: z.array(
    z.looseObject({
      id: z.string(),
      changes: z.array(z.looseObject({ field: z.string(), value: z.record(z.string(), z.unknown()) })),
    }),
  ),
});

export type SplitResult =
  | { readonly ok: true; readonly changes: readonly { route: WebhookRoute; change: WebhookChange }[] }
  | { readonly ok: false; readonly problem: string };

/**
 * Splits a verified webhook body into one change per queue: statuses, inbound messages, and everything else
 * (account events). A `messages` change carrying both statuses and messages goes to both queues.
 */
export function splitWebhook(body: unknown, receivedAt: Date): SplitResult {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) return { ok: false, problem: parsed.error.issues[0]?.message ?? 'invalid payload' };
  if (parsed.data.object !== 'whatsapp_business_account') {
    return { ok: false, problem: `unexpected object ${parsed.data.object}` };
  }

  const changes: { route: WebhookRoute; change: WebhookChange }[] = [];
  for (const entry of parsed.data.entry) {
    for (const { field, value } of entry.changes) {
      const metadata = value['metadata'] as { phone_number_id?: unknown } | undefined;
      const phoneNumberId =
        typeof metadata?.phone_number_id === 'string' ? metadata.phone_number_id : undefined;
      const change: WebhookChange = {
        receivedAt: receivedAt.toISOString(),
        wabaId: entry.id,
        ...(phoneNumberId === undefined ? {} : { phoneNumberId }),
        field,
        value,
      };
      if (field !== 'messages') {
        changes.push({ route: 'account', change });
        continue;
      }
      if (Array.isArray(value['statuses'])) changes.push({ route: 'status', change });
      if (Array.isArray(value['messages'])) changes.push({ route: 'inbound', change });
    }
  }
  return { ok: true, changes };
}
