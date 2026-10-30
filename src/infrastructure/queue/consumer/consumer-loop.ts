import { setTimeout as sleep } from 'node:timers/promises';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { AppError } from '../../../common/errors/index.js';
import { type Envelope, envelopeSchema } from '../envelope.js';
import type { ConsumerOptions, MessageHandler, Outcome } from './consumer.js';
import { park, retry } from './consumer.js';

export interface LoopLogger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface LoopDependencies {
  sqs: SQSClient;
  /** `SQS_QUEUE_URL_PREFIX`: the queue's URL is prefix + name. */
  queueUrlPrefix: string;
  logger: LoopLogger;
  /** Runs `fn` with the message's context (correlation ID in the request context and every log line). */
  inContext<R>(envelope: Envelope, queue: string, fn: () => Promise<R>): Promise<R>;
  /** Long-poll wait. 20 seconds in production. */
  waitSeconds?: number;
}

/** SQS's longest delay and visibility change. */
const MAX_DELAY_SECONDS = 900;
/** How long to wait before receiving again after a closed gate or a failed receive. */
const PAUSE_MS = 5_000;

/** 5 s, 10 s, 20 s ... up to 15 minutes. */
export function backoffSeconds(receiveCount: number): number {
  return Math.min(MAX_DELAY_SECONDS, 5 * 2 ** Math.max(0, receiveCount - 1));
}

/**
 * Consumes one queue: long-polls, keeps up to `concurrency` messages in flight, applies each handler's outcome
 * and deletes only what succeeded. A message whose handler is still running stays hidden (heartbeat); one whose
 * process died comes back after its visibility timeout. `stop()` stops receiving and waits for in-flight work.
 */
export class ConsumerLoop<T> {
  private running = false;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly queueUrl: string;
  private readonly dlqUrl: string;
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly visibilitySeconds: number;

  constructor(
    private readonly options: ConsumerOptions<T>,
    private readonly handler: MessageHandler<T>,
    private readonly deps: LoopDependencies,
  ) {
    this.queueUrl = `${deps.queueUrlPrefix}${options.queue}`;
    this.dlqUrl = `${deps.queueUrlPrefix}${options.queue}-dlq`;
    this.concurrency = options.concurrency ?? 10;
    this.batchSize = Math.min(10, options.batchSize ?? 10);
    this.visibilitySeconds = options.visibilitySeconds ?? 60;
  }

  start(): void {
    this.running = true;
    this.loop = this.run();
  }

  /** Stops receiving, then waits up to `timeoutMs` for in-flight messages. Unfinished ones come back later. */
  async stop(timeoutMs = 25_000): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.loop;
    await Promise.race([Promise.allSettled([...this.inFlight]), sleep(timeoutMs)]);
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (this.handler.gate !== undefined && !(await this.handler.gate())) {
          await this.pause();
          continue;
        }
        const room = this.concurrency - this.inFlight.size;
        if (room <= 0) {
          await Promise.race(this.inFlight);
          continue;
        }
        const { Messages = [] } = await this.deps.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: Math.min(this.batchSize, room),
            WaitTimeSeconds: this.deps.waitSeconds ?? 20,
            VisibilityTimeout: this.visibilitySeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: this.abort.signal },
        );
        for (const message of Messages) {
          const work = this.process(message).finally(() => this.inFlight.delete(work));
          this.inFlight.add(work);
        }
      } catch (err) {
        if (this.abort.signal.aborted) break;
        this.deps.logger.warn({ err, queue: this.options.queue }, 'receive failed');
        await this.pause();
      }
    }
  }

  private async pause(): Promise<void> {
    await sleep(PAUSE_MS, undefined, { signal: this.abort.signal }).catch(() => undefined);
  }

  private async process(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const parsed = this.parse(message.Body);
    if (typeof parsed === 'string') {
      this.deps.logger.error(
        { queue: this.options.queue, messageId: message.MessageId },
        `message parked: ${parsed}`,
      );
      await this.apply(message, park(parsed));
      return;
    }

    const heartbeat = setInterval(() => void this.extend(message), (this.visibilitySeconds * 1000) / 2);
    try {
      await this.deps.inContext(parsed.envelope, this.options.queue, async () => {
        const outcome = await this.handle(parsed.envelope, parsed.data, receiveCount);
        await this.apply(message, outcome, receiveCount);
      });
    } catch (err) {
      // Applying the outcome failed: the message comes back after its visibility timeout.
      this.deps.logger.warn({ err, queue: this.options.queue }, 'could not settle message');
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** The envelope and typed data, or why the message can't be handled. */
  private parse(body: string | undefined): { envelope: Envelope<T>; data: T } | string {
    let json: unknown;
    try {
      json = JSON.parse(body ?? '');
    } catch {
      return 'body is not JSON';
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) return 'not a valid envelope';
    if (envelope.data.type !== this.options.message.type) return `unexpected type ${envelope.data.type}`;
    const data = this.options.message.schema.safeParse(envelope.data.data);
    if (!data.success) return `invalid ${envelope.data.type} data`;
    return { envelope: { ...envelope.data, data: data.data }, data: data.data };
  }

  private async handle(envelope: Envelope<T>, data: T, receiveCount: number): Promise<Outcome> {
    try {
      return await this.handler.handle(data, { envelope, receiveCount });
    } catch (err) {
      const permanent = err instanceof AppError && !err.retryable;
      if (permanent) {
        this.deps.logger.error({ err, receiveCount }, 'message failed permanently');
        return park(`${err.code}: ${err.message}`);
      }
      this.deps.logger.warn({ err, receiveCount }, 'message failed, will retry');
      return retry();
    }
  }

  private async apply(message: Message, outcome: Outcome, receiveCount = 1): Promise<void> {
    const { sqs } = this.deps;
    const receipt = { QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle };
    switch (outcome.action) {
      case 'ack':
        await sqs.send(new DeleteMessageCommand(receipt));
        this.deps.logger.debug({}, 'message done');
        return;
      case 'retry': {
        const delay = Math.min(MAX_DELAY_SECONDS, outcome.delaySeconds ?? backoffSeconds(receiveCount));
        await sqs.send(new ChangeMessageVisibilityCommand({ ...receipt, VisibilityTimeout: delay }));
        return;
      }
      case 'park':
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: this.dlqUrl,
            MessageBody: message.Body,
            MessageAttributes: {
              parkReason: { DataType: 'String', StringValue: outcome.reason.slice(0, 1000) },
              sourceQueue: { DataType: 'String', StringValue: this.options.queue },
            },
          }),
        );
        await sqs.send(new DeleteMessageCommand(receipt));
        this.deps.logger.error({ reason: outcome.reason }, 'message parked');
        return;
      case 'hold':
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: message.Body,
            DelaySeconds: Math.min(MAX_DELAY_SECONDS, outcome.delaySeconds),
          }),
        );
        await sqs.send(new DeleteMessageCommand(receipt));
        return;
    }
  }

  /** Keeps a message hidden while its handler is still running. */
  private async extend(message: Message): Promise<void> {
    try {
      await this.deps.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: this.visibilitySeconds,
        }),
      );
    } catch (err) {
      this.deps.logger.warn({ err, queue: this.options.queue }, 'could not extend message visibility');
    }
  }
}
