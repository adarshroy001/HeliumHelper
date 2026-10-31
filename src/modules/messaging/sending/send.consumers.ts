import {
  Consumer,
  type MessageHandler,
  type Outcome,
  type ReceivedMessage,
} from '../../../infrastructure/queue/index.js';
import {
  type DeliverySendData,
  deliverySend,
  WA_SEND_P1_QUEUE,
  WA_SEND_P2_QUEUE,
} from '../messaging.messages.js';
import { SenderService } from './sender.service.js';

// Each process keeps this many sends in flight: enough to reach the number's rate at Meta's latency, plus the
// wait for a batched write. Campaign traffic gets the larger share; p1 also has its reserved tokens.

/** Direct sends, auto-replies and test sends. */
@Consumer({ queue: WA_SEND_P1_QUEUE, message: deliverySend, concurrency: 50, visibilitySeconds: 30 })
export class SendP1Consumer implements MessageHandler<DeliverySendData> {
  constructor(private readonly sender: SenderService) {}

  gate(): Promise<boolean> {
    return this.sender.canSend(1);
  }

  handle(data: DeliverySendData, { receiveCount }: ReceivedMessage<DeliverySendData>): Promise<Outcome> {
    return this.sender.send(data, 1, receiveCount);
  }
}

/** Campaign sends. */
@Consumer({ queue: WA_SEND_P2_QUEUE, message: deliverySend, concurrency: 200, visibilitySeconds: 30 })
export class SendP2Consumer implements MessageHandler<DeliverySendData> {
  constructor(private readonly sender: SenderService) {}

  gate(): Promise<boolean> {
    return this.sender.canSend(2);
  }

  handle(data: DeliverySendData, { receiveCount }: ReceivedMessage<DeliverySendData>): Promise<Outcome> {
    return this.sender.send(data, 2, receiveCount);
  }
}
