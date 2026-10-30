import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type BatchResultErrorEntry,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { appConfig, type AppConfig, queueConfig, type QueueConfig } from '../../config/index.js';
import { type Envelope, envelopeSchema, InvalidMessageError, type MessageType } from './envelope.js';

export interface PublishOptions {
  /**
   * Required on FIFO queues (`.fifo`): messages with one group id are delivered in order. On standard queues
   * with fair queues on, it is the tenant (a campaign, say), so one busy tenant can't starve the others.
   */
  groupId?: string;
  /** Hide the message for up to 900 seconds. Not on FIFO queues. */
  delaySeconds?: number;
}

/** SQS takes at most this many messages per batch request. */
const BATCH_SIZE = 10;
/** Attempts for entries SQS failed on its side, with backoff. Entries rejected as our fault fail at once. */
const MAX_ATTEMPTS = 3;

/** Some messages could not be sent. Lists which, and why. */
export class QueuePublishError extends Error {
  override readonly name = 'QueuePublishError';

  constructor(queue: string, failed: readonly BatchResultErrorEntry[]) {
    super(
      `Could not send ${String(failed.length)} message(s) to ${queue}: ${failed
        .map((f) => `${f.Code ?? 'unknown'} ${f.Message ?? ''}`.trim())
        .join('; ')}`,
    );
  }
}

/**
 * Puts work on a queue (ADR-0006). Every message is wrapped in the envelope and validated, with its data, before
 * anything is sent. Inside a request, `correlationId` is the request ID; inside a consumer, the incoming
 * message's correlation ID.
 */
@Injectable()
export class QueuePublisher {
  constructor(
    private readonly sqs: SQSClient,
    @Inject(queueConfig.KEY) private readonly config: QueueConfig,
    @Inject(appConfig.KEY) private readonly app: AppConfig,
    private readonly cls: ClsService,
  ) {}

  /** Sends one message to `queue` (its short name, such as `wa-send`). Returns the message id. */
  async publish<T>(
    queue: string,
    message: MessageType<T>,
    data: T,
    options: PublishOptions = {},
  ): Promise<string> {
    const [id] = await this.publishBatch(queue, message, [{ data, ...options }]);
    if (id === undefined) throw new Error('publishBatch returned no id');
    return id;
  }

  /**
   * Sends many messages, ten per request. All are validated first, so an invalid one means none are sent.
   * Entries SQS fails on its side are retried; the call fails if any message still isn't sent. Returns the ids
   * in input order.
   */
  async publishBatch<T>(
    queue: string,
    message: MessageType<T>,
    items: readonly ({ data: T } & PublishOptions)[],
  ): Promise<string[]> {
    const fifo = queue.endsWith('.fifo');
    const entries = items.map((item, index) => {
      const envelope = this.envelope(message, item.data);
      return { envelope, entry: this.entry(String(index), envelope, item, fifo) };
    });

    const url = `${this.config.queueUrlPrefix}${queue}`;
    for (let start = 0; start < entries.length; start += BATCH_SIZE) {
      await this.sendChunk(
        queue,
        url,
        entries.slice(start, start + BATCH_SIZE).map(({ entry }) => entry),
      );
    }
    return entries.map(({ envelope }) => envelope.id);
  }

  private envelope<T>(message: MessageType<T>, data: T): Envelope<T> {
    const parsedData = message.schema.safeParse(data);
    if (!parsedData.success) throw new InvalidMessageError(message.type, parsedData.error.issues);

    const envelope = {
      v: 1 as const,
      id: randomUUID(),
      type: message.type,
      ts: new Date().toISOString(),
      producer: this.app.name,
      correlationId: this.cls.isActive() ? this.cls.getId() : randomUUID(),
      data: parsedData.data,
    };
    const parsed = envelopeSchema.safeParse(envelope);
    if (!parsed.success) throw new InvalidMessageError(message.type, parsed.error.issues);
    return envelope;
  }

  private entry(
    id: string,
    envelope: Envelope,
    options: PublishOptions,
    fifo: boolean,
  ): SendMessageBatchRequestEntry {
    if (fifo && options.groupId === undefined) {
      throw new InvalidMessageError(envelope.type, [
        { code: 'custom', path: ['groupId'], message: 'is required on a FIFO queue', input: undefined },
      ]);
    }
    const sendGroup = options.groupId !== undefined && (fifo || this.config.fairQueues);
    return {
      Id: id,
      MessageBody: JSON.stringify(envelope),
      ...(sendGroup ? { MessageGroupId: options.groupId } : {}),
      ...(fifo ? { MessageDeduplicationId: envelope.id } : {}),
      ...(options.delaySeconds === undefined ? {} : { DelaySeconds: options.delaySeconds }),
    };
  }

  private async sendChunk(
    queue: string,
    url: string,
    entries: SendMessageBatchRequestEntry[],
  ): Promise<void> {
    let pending = entries;
    for (let attempt = 1; ; attempt += 1) {
      const result = await this.sqs.send(new SendMessageBatchCommand({ QueueUrl: url, Entries: pending }));
      const failed = result.Failed ?? [];
      if (failed.length === 0) return;

      const ourFault = failed.some((f) => f.SenderFault === true);
      if (ourFault || attempt === MAX_ATTEMPTS) throw new QueuePublishError(queue, failed);
      const retry = new Set(failed.map((f) => f.Id));
      pending = pending.filter((entry) => retry.has(entry.Id));
      await sleep(100 * 2 ** attempt);
    }
  }
}
