import { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { queueConfig, type QueueConfig, workerConfig, type WorkerConfig } from '../../../config/index.js';
import type { Envelope } from '../envelope.js';
import { CONSUMER_OPTIONS, type ConsumerOptions, type MessageHandler } from './consumer.js';
import { ConsumerLoop } from './consumer-loop.js';
import { type BackgroundLoop, WORKER_LOOP } from './worker-loop.js';

/**
 * Finds every `@Consumer` class at startup and runs the ones `WORKER_QUEUES` names, one loop per queue. Each
 * message runs in its own context: `ClsService.getId()` is the message's correlation ID, and every log line
 * carries `correlationId`, `messageId` and `queue`. On shutdown, all loops stop receiving and finish their
 * in-flight messages before the process exits.
 */
@Injectable()
export class ConsumerRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loops: ConsumerLoop<unknown>[] = [];
  private readonly background: BackgroundLoop[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly sqs: SQSClient,
    @Inject(queueConfig.KEY) private readonly queue: QueueConfig,
    @Inject(workerConfig.KEY) private readonly worker: WorkerConfig,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ConsumerRunner.name);
  }

  onApplicationBootstrap(): void {
    const consumers = this.discovery.getProviders().flatMap((wrapper) => {
      const options =
        typeof wrapper.metatype === 'function'
          ? this.reflector.get<ConsumerOptions<unknown> | undefined>(CONSUMER_OPTIONS, wrapper.metatype)
          : undefined;
      return options === undefined ? [] : [{ options, handler: wrapper.instance as MessageHandler<unknown> }];
    });

    const loops = this.discovery.getProviders().flatMap((wrapper) => {
      const name =
        typeof wrapper.metatype === 'function'
          ? this.reflector.get<string | undefined>(WORKER_LOOP, wrapper.metatype)
          : undefined;
      return name === undefined ? [] : [{ name, loop: wrapper.instance as BackgroundLoop }];
    });

    const wanted = this.worker.queues;
    const selected = wanted === 'all' ? consumers : consumers.filter((c) => wanted.includes(c.options.queue));
    if (wanted !== 'all') {
      const known = new Set([...consumers.map((c) => c.options.queue), ...loops.map((l) => l.name)]);
      const missing = wanted.filter((queue) => !known.has(queue));
      if (missing.length > 0) {
        throw new Error(`WORKER_QUEUES names queues with no consumer: ${missing.join(', ')}`);
      }
    }
    for (const { name, loop } of loops) {
      if (wanted !== 'all' && !wanted.includes(name)) continue;
      loop.start();
      this.background.push(loop);
      this.logger.info({ loop: name }, 'running');
    }
    if (selected.length === 0) this.logger.warn('no consumers to run: set WORKER_QUEUES');

    for (const { options, handler } of selected) {
      const loop = new ConsumerLoop(options, handler, {
        sqs: this.sqs,
        queueUrlPrefix: this.queue.queueUrlPrefix,
        logger: this.logger,
        inContext: (envelope, queue, fn) => this.inContext(envelope, queue, fn),
      });
      loop.start();
      this.loops.push(loop);
      this.logger.info({ queue: options.queue, concurrency: options.concurrency ?? 10 }, 'consuming');
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([
      ...this.loops.map((loop) => loop.stop()),
      ...this.background.map((loop) => loop.stop()),
    ]);
    this.logger.info({ queues: this.loops.length }, 'consumers stopped');
  }

  private inContext<R>(envelope: Envelope, queue: string, fn: () => Promise<R>): Promise<R> {
    return this.cls.run(() => {
      this.cls.set(CLS_ID, envelope.correlationId);
      return this.logger.runInContext(fn, {
        bindings: {
          correlationId: envelope.correlationId,
          messageId: envelope.id,
          type: envelope.type,
          queue,
        },
      });
    });
  }
}
