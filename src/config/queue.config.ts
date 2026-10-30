import { registerAs, type ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { loadConfig, type RawEnv } from './config.loader.js';

/** Variables for SQS (ADR-0006). Locally they point at ElasticMQ. */
export const queueEnvSchema = z.object({
  /** AWS region of the queues. */
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}-[a-z]+-\d$/, 'must be an AWS region such as ap-south-1')
    .default('ap-south-1'),
  /** ElasticMQ's URL locally. Empty in AWS, where the SDK finds SQS itself. */
  SQS_ENDPOINT: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
  /**
   * A queue's URL without its short name, so `prefix + "wa-send"` is the queue's URL. In AWS:
   * `https://sqs.ap-south-1.amazonaws.com/<account>/helium-staging-`.
   */
  SQS_QUEUE_URL_PREFIX: z.url({ protocol: /^https?$/ }),
  /** Send `MessageGroupId` to standard (fair) queues. ElasticMQ doesn't support fair queues: `false` locally. */
  SQS_FAIR_QUEUES: z.stringbool({ truthy: ['true'], falsy: ['false'] }).default(true),
});

/** Typed queue config, built from the validated variables. */
export function parseQueueConfig(env: RawEnv) {
  const vars = loadConfig('queue', queueEnvSchema, env);
  return {
    region: vars.AWS_REGION,
    endpoint: vars.SQS_ENDPOINT === '' ? undefined : vars.SQS_ENDPOINT,
    queueUrlPrefix: vars.SQS_QUEUE_URL_PREFIX,
    fairQueues: vars.SQS_FAIR_QUEUES,
  };
}

/** Inject with `@Inject(queueConfig.KEY) private readonly queue: QueueConfig`. */
export const queueConfig = registerAs('queue', () => parseQueueConfig(process.env));
export type QueueConfig = ConfigType<typeof queueConfig>;
