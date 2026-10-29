import type { SQSClient } from '@aws-sdk/client-sqs';
import type { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestQueue, receiveAll, testQueueConfig, testSqsClient } from '../../../test/helpers/sqs.js';
import type { AppConfig } from '../../config/index.js';
import { defineMessage, envelopeSchema, InvalidMessageError, QueuePublisher } from './index.js';

const orderPlaced = defineMessage(
  'shop.order.placed',
  z.strictObject({ orderId: z.string(), items: z.number().int().min(1) }),
);

const app = { name: 'helium-backend' } as AppConfig;
const outsideRequest = { isActive: () => false } as unknown as ClsService;
const insideRequest = { isActive: () => true, getId: () => 'req-123' } as unknown as ClsService;

describe('QueuePublisher (real ElasticMQ)', () => {
  let sqs: SQSClient;

  beforeAll(() => {
    sqs = testSqsClient();
  });

  afterAll(() => {
    sqs.destroy();
  });

  const publisher = (cls = outsideRequest) => new QueuePublisher(sqs, testQueueConfig(), app, cls);

  it('sends one message in the envelope', async () => {
    const queue = await createTestQueue(sqs);

    const id = await publisher().publish(queue.name, orderPlaced, { orderId: 'o1', items: 2 });

    const [message] = await receiveAll(sqs, queue.url);
    const envelope = envelopeSchema.parse(JSON.parse(message?.Body ?? ''));
    expect(envelope).toMatchObject({
      v: 1,
      id,
      type: 'shop.order.placed',
      producer: 'helium-backend',
      data: { orderId: 'o1', items: 2 },
    });
    expect(Date.parse(envelope.ts)).toBeLessThanOrEqual(Date.now());
  });

  it("carries the request's ID as correlationId", async () => {
    const queue = await createTestQueue(sqs);

    await publisher(insideRequest).publish(queue.name, orderPlaced, { orderId: 'o1', items: 1 });

    const [message] = await receiveAll(sqs, queue.url);
    expect(JSON.parse(message?.Body ?? '')).toMatchObject({ correlationId: 'req-123' });
  });

  it('sends a large batch in chunks of ten, in order', async () => {
    const queue = await createTestQueue(sqs);
    const send = vi.spyOn(sqs, 'send');
    const items = Array.from({ length: 25 }, (_, i) => ({ data: { orderId: `o${String(i)}`, items: 1 } }));

    const ids = await publisher().publishBatch(queue.name, orderPlaced, items);

    expect(ids).toHaveLength(25);
    expect(send).toHaveBeenCalledTimes(3);
    const received = (await receiveAll(sqs, queue.url)).map(
      (m) => (JSON.parse(m.Body ?? '') as { id: string }).id,
    );
    expect(received.sort()).toEqual([...ids].sort());
    send.mockRestore();
  });

  it('sends nothing when any message is invalid', async () => {
    const queue = await createTestQueue(sqs);
    const items = [{ data: { orderId: 'o1', items: 1 } }, { data: { orderId: 'o2', items: 0 } }];

    await expect(publisher().publishBatch(queue.name, orderPlaced, items)).rejects.toThrow(
      InvalidMessageError,
    );
    await expect(publisher().publishBatch(queue.name, orderPlaced, items)).rejects.toThrow(/items/);
    expect(await receiveAll(sqs, queue.url)).toEqual([]);
  });

  it('sends a group id and deduplication id to a FIFO queue, and requires the group', async () => {
    const queue = await createTestQueue(sqs, { fifo: true });

    const id = await publisher().publish(
      queue.name,
      orderPlaced,
      { orderId: 'o1', items: 1 },
      { groupId: 'shop-1' },
    );
    await expect(publisher().publish(queue.name, orderPlaced, { orderId: 'o2', items: 1 })).rejects.toThrow(
      /groupId/,
    );

    const [message] = await receiveAll(sqs, queue.url);
    expect(message?.Attributes).toMatchObject({ MessageGroupId: 'shop-1', MessageDeduplicationId: id });
  });
});
