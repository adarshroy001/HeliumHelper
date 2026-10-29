import type { SQSClient } from '@aws-sdk/client-sqs';
import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppConfig, QueueConfig } from '../../config/index.js';
import { defineMessage, QueuePublisher, QueuePublishError } from './index.js';

const ping = defineMessage('test.ping.sent', z.strictObject({ n: z.number() }));
const config: QueueConfig = {
  region: 'ap-south-1',
  endpoint: undefined,
  queueUrlPrefix: 'https://q/',
  fairQueues: true,
};
const cls = { isActive: () => false } as unknown as ClsService;

function publisherWith(responses: object[]) {
  const send = vi.fn();
  for (const response of responses) send.mockResolvedValueOnce(response);
  const publisher = new QueuePublisher(
    { send } as unknown as SQSClient,
    config,
    { name: 'svc' } as AppConfig,
    cls,
  );
  return { publisher, send };
}

const entriesOf = (call: unknown[]) =>
  (call[0] as { input: { Entries: { Id: string; MessageGroupId?: string }[] } }).input.Entries;

describe('QueuePublisher batch handling', () => {
  it('retries only the entries SQS failed on its side', async () => {
    const { publisher, send } = publisherWith([
      { Failed: [{ Id: '1', SenderFault: false, Code: 'InternalError' }] },
      { Failed: [] },
    ]);

    await publisher.publishBatch('jobs', ping, [{ data: { n: 1 } }, { data: { n: 2 } }]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(entriesOf(send.mock.calls[1] ?? []).map((e) => e.Id)).toEqual(['1']);
  });

  it('fails at once when SQS rejects an entry as our fault', async () => {
    const { publisher, send } = publisherWith([
      { Failed: [{ Id: '0', SenderFault: true, Code: 'InvalidParameterValue', Message: 'too big' }] },
    ]);

    await expect(publisher.publish('jobs', ping, { n: 1 })).rejects.toThrow(QueuePublishError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives up after three attempts', async () => {
    const failing = { Failed: [{ Id: '0', SenderFault: false, Code: 'InternalError' }] };
    const { publisher, send } = publisherWith([failing, failing, failing]);

    await expect(publisher.publish('jobs', ping, { n: 1 })).rejects.toThrow(/InternalError/);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('sends the group id to a standard queue only when fair queues are on', async () => {
    const { publisher, send } = publisherWith([{ Failed: [] }]);

    await publisher.publish('jobs', ping, { n: 1 }, { groupId: 'campaign-1' });

    expect(entriesOf(send.mock.calls[0] ?? [])[0]?.MessageGroupId).toBe('campaign-1');
  });
});
