import { z } from 'zod';
import { defineMessage } from '../../infrastructure/queue/index.js';

/** Queues of the messaging module (docs/modules/messaging/data-model.md#queues). */
export const WA_STATUS_QUEUE = 'wa-status';
export const WA_INBOUND_QUEUE = 'wa-inbound';
export const WA_ACCOUNT_QUEUE = 'wa-account';

const webhookChange = z.strictObject({
  receivedAt: z.iso.datetime(),
  wabaId: z.string(),
  phoneNumberId: z.string().optional(),
  field: z.string(),
  value: z.record(z.string(), z.unknown()),
});
export type WebhookChangeData = z.infer<typeof webhookChange>;

/** A webhook change with delivery statuses (`value.statuses`). */
export const webhookStatus = defineMessage('wa.webhook.status', webhookChange);
/** A webhook change with inbound messages (`value.messages`). */
export const webhookInbound = defineMessage('wa.webhook.inbound', webhookChange);
/** Any other webhook field: templates, phone quality, messaging limits, account updates. */
export const webhookAccount = defineMessage('wa.webhook.account', webhookChange);

/** Send queues: direct sends, auto-replies and tests on p1; campaigns on p2 (a fair queue per campaign). */
export const WA_SEND_P1_QUEUE = 'wa-send-p1';
export const WA_SEND_P2_QUEUE = 'wa-send-p2';

const templatePayload = z.strictObject({
  name: z.string().min(1),
  language: z.strictObject({ code: z.string().min(2) }),
  components: z.array(z.record(z.string(), z.unknown())).readonly().optional(),
});

/**
 * One message to send, with everything the sender needs, so it never reads the database
 * (docs/modules/messaging/design.md#the-send-message).
 */
export const deliverySend = defineMessage(
  'wa.delivery.send',
  z.strictObject({
    deliveryId: z.string().min(1),
    accountId: z.string().min(1),
    phoneNumberId: z.string().min(1),
    to: z.string().regex(/^91[6-9]\d{9}$/),
    endpoint: z.enum(['messages', 'marketing_messages']),
    campaignId: z.string().optional(),
    payload: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('template'), template: templatePayload }),
      z.strictObject({ kind: z.literal('text'), text: z.string().min(1).max(4096) }),
    ]),
    /** A message we start (marketing, utility), as opposed to a reply inside the service window. */
    businessInitiated: z.boolean(),
    unconfirmedRetry: z.boolean().optional(),
  }),
);
export type DeliverySendData = z.infer<typeof deliverySend.schema>;
