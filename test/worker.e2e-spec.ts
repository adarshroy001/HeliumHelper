import { Module } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ack,
  Consumer,
  defineMessage,
  type MessageHandler,
  type ReceivedMessage,
  QueuePublisher,
} from '../src/infrastructure/queue/index.js';
import { WorkerModule } from '../src/worker.module.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { createTestQueue, testSqsClient } from './helpers/sqs.js';

const QUEUE = 'worker-e2e';
const greet = defineMessage('test.greeting.sent', z.strictObject({ name: z.string() }));
type Greet = z.infer<typeof greet.schema>;

@Consumer({ queue: QUEUE, message: greet })
class GreetConsumer implements MessageHandler<Greet> {
  readonly seen: { name: string; contextId: string; correlationId: string }[] = [];

  constructor(private readonly cls: ClsService) {}

  handle(data: Greet, message: ReceivedMessage<Greet>) {
    this.seen.push({
      name: data.name,
      contextId: this.cls.getId(),
      correlationId: message.envelope.correlationId,
    });
    return Promise.resolve(ack());
  }
}

@Module({ imports: [WorkerModule], providers: [GreetConsumer] })
class TestWorkerModule {}

describe('worker process', () => {
  const original = { ...process.env };
  let t: TestApp;

  beforeAll(async () => {
    const sqs = testSqsClient();
    await createTestQueue(sqs, { name: QUEUE });
    await createTestQueue(sqs, { name: `${QUEUE}-dlq` });
    sqs.destroy();
    process.env['WORKER_QUEUES'] = QUEUE;
    t = await createTestApp({ module: TestWorkerModule });
  });

  afterAll(async () => {
    await t.app.close();
    process.env = { ...original };
  });

  it('runs the consumers WORKER_QUEUES names, each message in its own context', async () => {
    await t.app.get(QueuePublisher).publish(QUEUE, greet, { name: 'asha' });

    const consumer = t.app.get(GreetConsumer);
    await vi.waitFor(
      () => {
        expect(consumer.seen).toHaveLength(1);
      },
      { timeout: 30_000 },
    );
    const [seen] = consumer.seen;
    expect(seen?.name).toBe('asha');
    expect(seen?.contextId).toBe(seen?.correlationId);
  });

  it('serves its health endpoint', async () => {
    expect((await request(t.http).get('/health/ready')).status).toBe(200);
  });

  it('refuses to start when WORKER_QUEUES names a queue without a consumer', async () => {
    process.env['WORKER_QUEUES'] = `${QUEUE},no-such-queue`;

    await expect(createTestApp({ module: TestWorkerModule })).rejects.toThrow(/no-such-queue/);
  });
});
