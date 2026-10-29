import { readFileSync } from 'node:fs';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { QUEUES } from '../config/queues.ts';
import { loadSchedules } from '../lib/data-stack.ts';
import { stagingStacks } from './stacks.ts';

const { data } = stagingStacks();
const template = Template.fromStack(data);

describe('DataStack', () => {
  it('runs Valkey with a replica in another zone, TLS, an auth token and noeviction', () => {
    template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      Engine: 'valkey',
      NumCacheClusters: 2,
      AutomaticFailoverEnabled: true,
      MultiAZEnabled: true,
      TransitEncryptionEnabled: true,
      AtRestEncryptionEnabled: true,
      AuthToken: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::ElastiCache::ParameterGroup', {
      Properties: { 'maxmemory-policy': 'noeviction' },
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { FromPort: 6379, ToPort: 6379 });
  });

  it('creates every queue with an encrypted DLQ and both alarms', () => {
    for (const queue of QUEUES) {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: `helium-staging-${queue.name}`,
        VisibilityTimeout: queue.visibilitySeconds,
        RedrivePolicy: Match.objectLike({ maxReceiveCount: queue.maxReceiveCount }),
        SqsManagedSseEnabled: true,
      });
      template.hasResourceProperties('AWS::SQS::Queue', { QueueName: `helium-staging-${queue.name}-dlq` });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `helium-staging-${queue.name}-oldest-message`,
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `helium-staging-${queue.name}-dlq`,
      });
    }
  });

  it('creates one EventBridge schedule per entry of the registry, unchanged (F18)', () => {
    const schedules = loadSchedules();
    expect(schedules.length).toBeGreaterThan(0);
    template.resourceCountIs('AWS::Scheduler::Schedule', schedules.length);
    for (const schedule of schedules) {
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        Name: schedule.name,
        ScheduleExpression: schedule.scheduleExpression,
        ScheduleExpressionTimezone: schedule.timezone,
        Target: Match.objectLike({ Input: schedule.input }),
      });
    }
  });

  it('lets the services reach the existing DocumentDB cluster', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      GroupId: 'sg-00000000000000001',
      FromPort: 27017,
      ToPort: 27017,
    });
  });
});

describe('queue lists', () => {
  it('declares the same queues locally (docker/elasticmq.conf) as in AWS', () => {
    const conf = readFileSync(new URL('../../docker/elasticmq.conf', import.meta.url), 'utf8');
    const local = [...conf.matchAll(/^\s+helium-local-([a-z\d-]+)\s*\{/gm)].map((m) => m[1]).sort();

    expect(local).toEqual(QUEUES.flatMap((q) => [q.name, `${q.name}-dlq`]).sort());
  });

  it('targets only known queues from schedules', () => {
    const names = QUEUES.map((q) => q.name);

    expect(loadSchedules().filter((s) => !names.includes(s.queue))).toEqual([]);
  });
});
