import { ack, Consumer, type MessageHandler, type Outcome } from '../../../infrastructure/queue/index.js';
import { WA_INBOUND_QUEUE, type WebhookChangeData, webhookInbound } from '../messaging.messages.js';
import { parseInbound } from './inbound-parser.js';
import { InboundService } from './inbound.service.js';

/** Messages customers send us, one webhook change at a time. Idempotent by each message's wamid. */
@Consumer({ queue: WA_INBOUND_QUEUE, message: webhookInbound, concurrency: 20 })
export class InboundConsumer implements MessageHandler<WebhookChangeData> {
  constructor(private readonly inbound: InboundService) {}

  async handle(data: WebhookChangeData): Promise<Outcome> {
    await this.inbound.handle(parseInbound(data.value));
    return ack();
  }
}
