import { ack, Consumer, type MessageHandler, type Outcome } from '../../../infrastructure/queue/index.js';
import { WA_ACCOUNT_QUEUE, type WebhookChangeData, webhookAccount } from '../messaging.messages.js';
import { AccountEventsService } from './account-events.service.js';

/** Meta's account-level webhooks: templates, phone quality, messaging limits, account restrictions. */
@Consumer({ queue: WA_ACCOUNT_QUEUE, message: webhookAccount, concurrency: 5 })
export class AccountConsumer implements MessageHandler<WebhookChangeData> {
  constructor(private readonly events: AccountEventsService) {}

  async handle(data: WebhookChangeData): Promise<Outcome> {
    await this.events.handle(data);
    return ack();
  }
}
