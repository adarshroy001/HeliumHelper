import { PinoLogger } from 'nestjs-pino';
import {
  ack,
  Consumer,
  type MessageHandler,
  type Outcome,
  type ReceivedMessage,
  retry,
} from '../../../infrastructure/queue/index.js';
import { WA_STATUS_QUEUE, type WebhookChangeData, webhookStatus } from '../messaging.messages.js';
import { parseStatuses } from './status-parser.js';
import { StatusService } from './status.service.js';

/** Receives an unmatched status this many times (30 s apart) before recording it as unmatched. */
const MATCH_ATTEMPTS = 5;

/**
 * Applies the statuses of one webhook change. Statuses whose delivery isn't known yet are retried a few times,
 * then recorded in `unmatched_statuses`; applying the matched ones again on a retry changes nothing.
 */
@Consumer({ queue: WA_STATUS_QUEUE, message: webhookStatus, concurrency: 50 })
export class StatusConsumer implements MessageHandler<WebhookChangeData> {
  constructor(
    private readonly statuses: StatusService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(StatusConsumer.name);
  }

  async handle(
    data: WebhookChangeData,
    { receiveCount }: ReceivedMessage<WebhookChangeData>,
  ): Promise<Outcome> {
    const { statuses, ignored } = parseStatuses(data.value);
    if (ignored > 0) this.logger.debug({ ignored }, 'statuses ignored');
    const { matched, unmatched } = await this.statuses.correlate(statuses);
    await this.statuses.apply(matched);
    if (unmatched.length === 0) return ack();
    if (receiveCount < MATCH_ATTEMPTS) return retry(30);
    await this.statuses.recordUnmatched(unmatched, data.phoneNumberId);
    this.logger.info({ unmatched: unmatched.length }, 'statuses recorded as unmatched');
    return ack();
  }
}
