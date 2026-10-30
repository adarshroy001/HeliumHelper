import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createTestQueue,
  receiveAll,
  type TestQueue,
  testQueueConfig,
  testSqsClient,
} from '../../../../test/helpers/sqs.js';
import type { AppConfig } from '../../../config/index.js';
import { ValidationError } from '../../../common/errors/index.js';
import {
  ack,
  defineMessage,
  hold,
  type MessageHandler,
  type Outcome,
  park,
  QueuePublisher,
  retry,
} from '../index.js';
import { ConsumerLoop, type LoopDependencies } from './consumer-loop.js';

const job = defineMessage('test.job.run', z.strictObject({ n: z.number() }));
type Job = z.infer<typeof job.schema>;

const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('ConsumerLoop (real ElasticMQ)', () => {
  let sqs: SQSClient;
  let publisher: QueuePublisher;
  const loops: ConsumerLoop<Job>[] = [];

  beforeAll(() => {
    sqs = testSqsClient();
    publisher = new QueuePublisher(
      sqs,
      testQueueConfig(),
      { name: 'test' } as AppConfig,
      {
        isActive: () => false,
      } as unknown as ClsService,
    );
  });

  afterAll(async () => {
    await Promise.all(loops.map((loop) => loop.stop(0)));
    sqs.destroy();
  });

  /** A queue with its DLQ (`<queue>-dlq`, where the loop parks), which SQS also uses after 3 receives. */
  async function queueWithDlq(visibilitySeconds = 30): Promise<{ queue: TestQueue; dlq: TestQueue }> {
    const name = `test-${randomUUID().slice(0, 8)}`;
    const dlq = await createTestQueue(sqs, { name: `${name}-dlq` });
    const queue = await createTestQueue(sqs, { name, dlq, maxReceiveCount: 3, visibilitySeconds });
    return { queue, dlq };
  }

  function consume(
    queue: TestQueue,
    handle: (data: Job, receiveCount: number) => Promise<Outcome>,
    options: { concurrency?: number; visibilitySeconds?: number; gate?: () => Promise<boolean> } = {},
  ): ConsumerLoop<Job> {
    const handler: MessageHandler<Job> = {
      handle: (data, message) => handle(data, message.receiveCount),
      ...(options.gate === undefined ? {} : { gate: options.gate }),
    };
    const deps: LoopDependencies = {
      sqs,
      queueUrlPrefix: testQueueConfig().queueUrlPrefix,
      logger: quiet,
      inContext: (_envelope, _queue, fn) => fn(),
      waitSeconds: 1,
    };
    const loop = new ConsumerLoop(
      {
        queue: queue.name,
        message: job,
        concurrency: options.concurrency ?? 5,
        visibilitySeconds: options.visibilitySeconds ?? 30,
      },
      handler,
      deps,
    );
    loop.start();
    loops.push(loop);
    return loop;
  }

  it('deletes a message its handler acks', async () => {
    const { queue } = await queueWithDlq();
    const seen: number[] = [];
    await publisher.publish(queue.name, job, { n: 1 });

    const loop = consume(queue, (data) => {
      seen.push(data.n);
      return Promise.resolve(ack());
    });
    await vi.waitFor(
      () => {
        expect(seen).toEqual([1]);
      },
      { timeout: 10_000 },
    );
    await loop.stop();

    expect(await receiveAll(sqs, queue.url)).toEqual([]);
  });

  it('retries after the requested delay, with a growing receive count', async () => {
    const { queue } = await queueWithDlq();
    const attempts: { count: number; at: number }[] = [];
    await publisher.publish(queue.name, job, { n: 1 });

    const loop = consume(queue, (_data, receiveCount) => {
      attempts.push({ count: receiveCount, at: Date.now() });
      return Promise.resolve(receiveCount === 1 ? retry(2) : ack());
    });
    await vi.waitFor(
      () => {
        expect(attempts).toHaveLength(2);
      },
      { timeout: 15_000 },
    );
    await loop.stop();

    expect(attempts.map((a) => a.count)).toEqual([1, 2]);
    expect((attempts[1]?.at ?? 0) - (attempts[0]?.at ?? 0)).toBeGreaterThanOrEqual(1_900);
  });

  it('parks a message to the DLQ with the reason, including a permanent AppError', async () => {
    const { queue, dlq } = await queueWithDlq();
    await publisher.publishBatch(queue.name, job, [{ data: { n: 1 } }, { data: { n: 2 } }]);

    const loop = consume(queue, (data) =>
      data.n === 1
        ? Promise.resolve(park('customer opted out'))
        : Promise.reject(new ValidationError({ n: 'bad' })),
    );
    await vi.waitFor(
      async () => {
        expect(await countIn(dlq.url)).toBe(2);
      },
      { timeout: 10_000 },
    );
    await loop.stop();

    const parked = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlq.url,
        MaxNumberOfMessages: 10,
        MessageAttributeNames: ['All'],
      }),
    );
    const reasons = (parked.Messages ?? [])
      .map((m) => m.MessageAttributes?.['parkReason']?.StringValue)
      .sort();
    expect(reasons).toEqual(['VALIDATION_FAILED: The request is invalid.', 'customer opted out']);
    expect(await receiveAll(sqs, queue.url)).toEqual([]);
  });

  it('retries a handler that throws, and the message comes back', async () => {
    const { queue } = await queueWithDlq();
    let calls = 0;
    await publisher.publish(queue.name, job, { n: 1 });

    const loop = consume(queue, () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('database timeout'));
      return Promise.resolve(ack());
    });
    // The default backoff for a first failure is 5 seconds.
    await vi.waitFor(
      () => {
        expect(calls).toBe(2);
      },
      { timeout: 15_000 },
    );
    await loop.stop();
  });

  it('gets a message back when the process that received it dies before finishing', async () => {
    const { queue } = await queueWithDlq(2);
    await publisher.publish(queue.name, job, { n: 1 });
    // A consumer that received the message and then crashed: it never deletes it.
    const crashed = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue.url, VisibilityTimeout: 2 }));
    expect(crashed.Messages).toHaveLength(1);

    const seen: number[] = [];
    const loop = consume(queue, (data) => {
      seen.push(data.n);
      return Promise.resolve(ack());
    });
    await vi.waitFor(
      () => {
        expect(seen).toEqual([1]);
      },
      { timeout: 10_000 },
    );
    await loop.stop();
  });

  it('parks a message that is not a valid envelope', async () => {
    const { queue, dlq } = await queueWithDlq();
    await sqs.send(new SendMessageCommand({ QueueUrl: queue.url, MessageBody: '{"hello":"world"}' }));

    const handle = vi.fn(() => Promise.resolve(ack()));
    const loop = consume(queue, handle);
    await vi.waitFor(
      async () => {
        expect(await countIn(dlq.url)).toBe(1);
      },
      { timeout: 10_000 },
    );
    await loop.stop();

    expect(handle).not.toHaveBeenCalled();
  });

  it('holds a message without counting it as a failed attempt', async () => {
    const { queue } = await queueWithDlq();
    const counts: number[] = [];
    await publisher.publish(queue.name, job, { n: 1 });

    const loop = consume(queue, (_data, receiveCount) => {
      counts.push(receiveCount);
      return Promise.resolve(counts.length === 1 ? hold(1) : ack());
    });
    await vi.waitFor(
      () => {
        expect(counts).toHaveLength(2);
      },
      { timeout: 10_000 },
    );
    await loop.stop();

    expect(counts).toEqual([1, 1]);
  });

  it('receives nothing while the gate is closed', async () => {
    const { queue } = await queueWithDlq();
    let open = false;
    const seen: number[] = [];
    await publisher.publish(queue.name, job, { n: 1 });

    const loop = consume(
      queue,
      (data) => {
        seen.push(data.n);
        return Promise.resolve(ack());
      },
      { gate: () => Promise.resolve(open) },
    );
    await sleep(1_500);
    expect(seen).toEqual([]);

    open = true;
    await vi.waitFor(
      () => {
        expect(seen).toEqual([1]);
      },
      { timeout: 10_000 },
    );
    await loop.stop();
  });

  it('keeps a slow message hidden while its handler runs', async () => {
    const { queue } = await queueWithDlq();
    let calls = 0;
    await publisher.publish(queue.name, job, { n: 1 });

    const loop = consume(
      queue,
      async () => {
        calls += 1;
        await sleep(3_500);
        return ack();
      },
      { visibilitySeconds: 2 },
    );
    await sleep(4_500);
    await loop.stop();

    expect(calls).toBe(1);
  });

  it('finishes in-flight messages on stop and leaves the rest in the queue', async () => {
    const { queue } = await queueWithDlq();
    await publisher.publishBatch(
      queue.name,
      job,
      [1, 2, 3, 4, 5].map((n) => ({ data: { n } })),
    );
    const done: number[] = [];
    let started = 0;

    const loop = consume(
      queue,
      async (data) => {
        started += 1;
        await sleep(500);
        done.push(data.n);
        return ack();
      },
      { concurrency: 2 },
    );
    await vi.waitFor(
      () => {
        expect(started).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    await loop.stop();

    const left = await receiveAll(sqs, queue.url);
    expect(done.length).toBe(started);
    expect(done.length + left.length).toBe(5);
  });

  async function countIn(url: string): Promise<number> {
    const attributes = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }),
    );
    return Number(attributes.Attributes?.['ApproximateNumberOfMessages'] ?? '0');
  }
});
