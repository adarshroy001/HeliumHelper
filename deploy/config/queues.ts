/**
 * Every SQS queue (ADR-0006). Each gets a DLQ (`<name>-dlq`) and two alarms. The same names, with the
 * `helium-local-` prefix, are in docker/elasticmq.conf; a test keeps the two lists equal.
 */
export interface QueueDefinition {
  /** Short name, as the app uses it (`QueuePublisher`, `@Consumer`). In AWS: `<prefix>-<name>`. */
  readonly name: string;
  readonly visibilitySeconds: number;
  /** Receives before SQS moves a message to the DLQ. */
  readonly maxReceiveCount: number;
  readonly alarms: {
    /** Alarm when the oldest message has waited this long: consumers are stuck or too slow. */
    readonly oldestMessageSeconds: number;
    /** Alarm when the DLQ holds at least this many messages. */
    readonly dlqMessages: number;
  };
}

export const QUEUES: readonly QueueDefinition[] = [
  {
    name: 'system-jobs',
    visibilitySeconds: 60,
    maxReceiveCount: 5,
    alarms: { oldestMessageSeconds: 15 * 60, dlqMessages: 1 },
  },
  {
    name: 'wa-status',
    visibilitySeconds: 60,
    // Unmatched statuses are held up to 5 times before they are recorded as unmatched.
    maxReceiveCount: 10,
    alarms: { oldestMessageSeconds: 120, dlqMessages: 1 },
  },
  {
    name: 'wa-inbound',
    visibilitySeconds: 60,
    maxReceiveCount: 5,
    alarms: { oldestMessageSeconds: 120, dlqMessages: 1 },
  },
  {
    name: 'wa-account',
    visibilitySeconds: 60,
    maxReceiveCount: 5,
    alarms: { oldestMessageSeconds: 300, dlqMessages: 1 },
  },
  {
    name: 'wa-send-p1',
    visibilitySeconds: 30,
    // Rate-limit waits happen before receiving, so only crash loops reach this.
    maxReceiveCount: 15,
    alarms: { oldestMessageSeconds: 60, dlqMessages: 1 },
  },
  {
    name: 'wa-send-p2',
    visibilitySeconds: 30,
    maxReceiveCount: 15,
    alarms: { oldestMessageSeconds: 15 * 60, dlqMessages: 1 },
  },
  {
    name: 'messaging-jobs',
    visibilitySeconds: 120,
    maxReceiveCount: 5,
    alarms: { oldestMessageSeconds: 30 * 60, dlqMessages: 1 },
  },
];
