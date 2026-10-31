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
