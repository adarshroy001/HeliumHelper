import { applyDecorators, Injectable, SetMetadata } from '@nestjs/common';
import type { Envelope, MessageType } from '../envelope.js';

/** What a handler decided about a message. Build one with `ack()`, `retry()`, `park()` or `hold()`. */
export type Outcome =
  | { readonly action: 'ack' }
  | { readonly action: 'retry'; readonly delaySeconds?: number | undefined }
  | { readonly action: 'park'; readonly reason: string }
  | { readonly action: 'hold'; readonly delaySeconds: number };

/** Done: the message is deleted. */
export const ack = (): Outcome => ({ action: 'ack' });

/**
 * Try again later: the message comes back after `delaySeconds` (by default a backoff that grows with each
 * attempt). After the queue's maximum receives, SQS moves it to the DLQ.
 */
export const retry = (delaySeconds?: number): Outcome => ({ action: 'retry', delaySeconds });

/** It will never succeed: move it to the DLQ now, with the reason, for a person to look at. */
export const park = (reason: string): Outcome => ({ action: 'park', reason });

/** Not now (a rate limit, a paused campaign): send it back in `delaySeconds`. Doesn't count as a failed attempt. */
export const hold = (delaySeconds: number): Outcome => ({ action: 'hold', delaySeconds });

export interface ReceivedMessage<T> {
  readonly envelope: Envelope<T>;
  /** 1 on the first delivery. */
  readonly receiveCount: number;
}

/** A class marked `@Consumer(...)`. */
export interface MessageHandler<T> {
  /** Handles one message. Throwing is a `retry`, or a `park` for an `AppError` that isn't retryable. */
  handle(data: T, message: ReceivedMessage<T>): Promise<Outcome>;
  /** Asked before each receive. `false` pauses consuming (for example while Redis is down): SQS keeps the work. */
  gate?(): Promise<boolean>;
}

export interface ConsumerOptions<T> {
  /** The queue's short name, as for `QueuePublisher`. Its DLQ is `<queue>-dlq`. */
  queue: string;
  /** The message type it consumes. Anything else is parked. */
  message: MessageType<T>;
  /** Most messages handled at once by one process. Default 10. */
  concurrency?: number;
  /** Most messages fetched per receive, 1 to 10. Default 10. */
  batchSize?: number;
  /** How long a received message stays hidden; renewed while the handler runs. Default 60. */
  visibilitySeconds?: number;
}

export const CONSUMER_OPTIONS = 'queue:consumer';

/**
 * Marks a class as the consumer of a queue. The worker process finds it and runs it when `WORKER_QUEUES`
 * names its queue:
 *
 * ```ts
 * @Consumer({ queue: 'wa-send', message: deliverySend, concurrency: 20 })
 * export class DeliverySendConsumer implements MessageHandler<DeliverySend> { ... }
 * ```
 */
export function Consumer<T>(options: ConsumerOptions<T>): ClassDecorator {
  return applyDecorators(Injectable(), SetMetadata(CONSUMER_OPTIONS, options));
}
