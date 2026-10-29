import { describe, expect, it } from 'vitest';
import { ConfigValidationError } from './config.loader.js';
import { parseQueueConfig } from './queue.config.js';

const local = {
  SQS_ENDPOINT: 'http://localhost:9324',
  SQS_QUEUE_URL_PREFIX: 'http://localhost:9324/000000000000/helium-local-',
  SQS_FAIR_QUEUES: 'false',
};

describe('parseQueueConfig', () => {
  it('reads a local ElasticMQ setup', () => {
    expect(parseQueueConfig(local)).toEqual({
      region: 'ap-south-1',
      endpoint: 'http://localhost:9324',
      queueUrlPrefix: 'http://localhost:9324/000000000000/helium-local-',
      fairQueues: false,
    });
  });

  it('defaults to real SQS with fair queues on', () => {
    const config = parseQueueConfig({
      SQS_QUEUE_URL_PREFIX: 'https://sqs.ap-south-1.amazonaws.com/123456789012/helium-staging-',
    });

    expect(config).toMatchObject({ endpoint: undefined, fairQueues: true });
  });

  it.each([
    ['SQS_QUEUE_URL_PREFIX', undefined],
    ['SQS_ENDPOINT', 'localhost:9324'],
    ['SQS_FAIR_QUEUES', 'yes'],
    ['AWS_REGION', 'mumbai'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => parseQueueConfig({ ...local, [key]: value })).toThrow(ConfigValidationError);
  });
});
