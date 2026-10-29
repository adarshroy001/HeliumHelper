import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { parseQueueConfig, type QueueConfig } from '../../src/config/queue.config.js';

/** The app's queue config for the test run's ElasticMQ. */
export function testQueueConfig(): QueueConfig {
  return parseQueueConfig(process.env);
}

/** A client for the test run's ElasticMQ, as the app builds it (test/global-setup.ts sets the endpoint). */
export function testSqsClient(): SQSClient {
  const endpoint = process.env['SQS_ENDPOINT'];
  if (endpoint === undefined)
    throw new Error('SQS_ENDPOINT is not set: run this through the int or e2e project');
  return new SQSClient({
    region: 'ap-south-1',
    endpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}

export interface TestQueue {
  /** The short name to publish to (the app's prefix + name is the URL). */
  name: string;
  url: string;
}

/**
 * Creates a queue with a unique name, optionally with a DLQ after `maxReceiveCount` receives.
 * `fifo` creates a `.fifo` queue.
 */
export async function createTestQueue(
  sqs: SQSClient,
  options: { fifo?: boolean; visibilitySeconds?: number; dlq?: TestQueue; maxReceiveCount?: number } = {},
): Promise<TestQueue> {
  const name = `test-${randomUUID().slice(0, 8)}${options.fifo === true ? '.fifo' : ''}`;
  const attributes: Record<string, string> = {
    VisibilityTimeout: String(options.visibilitySeconds ?? 30),
    ...(options.fifo === true ? { FifoQueue: 'true' } : {}),
  };
  if (options.dlq !== undefined) {
    const dlqArn = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: options.dlq.url, AttributeNames: ['QueueArn'] }),
    );
    attributes['RedrivePolicy'] = JSON.stringify({
      deadLetterTargetArn: dlqArn.Attributes?.['QueueArn'],
      maxReceiveCount: options.maxReceiveCount ?? 3,
    });
  }
  const created = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
  if (created.QueueUrl === undefined) throw new Error(`queue ${name} was not created`);
  return { name, url: `${process.env['SQS_QUEUE_URL_PREFIX'] ?? ''}${name}` };
}

/** Receives until the queue looks empty: every message currently visible. */
export async function receiveAll(sqs: SQSClient, url: string): Promise<Message[]> {
  const messages: Message[] = [];
  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        MessageSystemAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) return messages;
    messages.push(...Messages);
  }
}
