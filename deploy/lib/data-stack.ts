import { readFileSync } from 'node:fs';
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { type ISecurityGroup, type IVpc, Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { CfnParameterGroup, CfnReplicationGroup, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnSchedule, CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config/environments.ts';
import { QUEUES } from '../config/queues.ts';

/** One schedule as `pnpm schedules:export` writes it (src/infrastructure/queue/schedules/schedule.ts). */
export interface ExportedSchedule {
  readonly name: string;
  readonly description: string;
  readonly scheduleExpression: string;
  readonly timezone: string;
  readonly queue: string;
  readonly input: string;
}

/** The schedule registry, exported from the app (`deploy/schedules.json`). */
export function loadSchedules(): ExportedSchedule[] {
  return JSON.parse(
    readFileSync(new URL('../schedules.json', import.meta.url), 'utf8'),
  ) as ExportedSchedule[];
}

export interface DataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: IVpc;
  readonly servicesSecurityGroup: ISecurityGroup;
  readonly alarmTopic: ITopic;
}

/**
 * Data and queues of one environment (F24): ElastiCache for Valkey, every queue with its DLQ and alarms, the
 * EventBridge schedules, and the services' access to the existing DocumentDB cluster.
 */
export class DataStack extends Stack {
  /** `REDIS_URL` for the services. */
  readonly redisUrl: string;
  /** `REDIS_AUTH_TOKEN`: generated. */
  readonly redisAuthToken: Secret;
  /** Queue and DLQ by short name. */
  readonly queues: ReadonlyMap<string, { readonly queue: Queue; readonly dlq: Queue }>;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc, servicesSecurityGroup, alarmTopic } = props;

    // --- Valkey (ADR-0007): primary and replica in two zones, TLS, auth token, nothing evicted silently.
    const valkeySecurityGroup = new SecurityGroup(this, 'ValkeySecurityGroup', {
      vpc,
      securityGroupName: `${config.prefix}-valkey`,
      description: 'Valkey: reachable only from helium-backend tasks',
      allowAllOutbound: false,
    });
    valkeySecurityGroup.addIngressRule(servicesSecurityGroup, Port.tcp(6379), 'helium-backend tasks');

    this.redisAuthToken = new Secret(this, 'RedisAuthToken', {
      secretName: `helium/${config.name}/redis-auth-token`,
      description: 'REDIS_AUTH_TOKEN for ElastiCache',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const subnetGroup = new CfnSubnetGroup(this, 'ValkeySubnets', {
      description: `${config.prefix} Valkey subnets`,
      subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
    });
    const parameters = new CfnParameterGroup(this, 'ValkeyParameters', {
      cacheParameterGroupFamily: 'valkey8',
      description: `${config.prefix} Valkey: noeviction`,
      properties: { 'maxmemory-policy': 'noeviction' },
    });
    const valkey = new CfnReplicationGroup(this, 'Valkey', {
      replicationGroupId: `${config.prefix}-valkey`,
      replicationGroupDescription: `${config.prefix} coordination (locks, limits, idempotency)`,
      engine: 'valkey',
      engineVersion: '8.1',
      cacheNodeType: config.valkeyNodeType,
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      authToken: this.redisAuthToken.secretValue.unsafeUnwrap(),
      cacheSubnetGroupName: subnetGroup.ref,
      cacheParameterGroupName: parameters.ref,
      securityGroupIds: [valkeySecurityGroup.securityGroupId],
      snapshotRetentionLimit: 1,
    });
    this.redisUrl = `rediss://${valkey.attrPrimaryEndPointAddress}:${valkey.attrPrimaryEndPointPort}`;

    // --- Queues (ADR-0006): each with a DLQ and alarms.
    const queues = new Map<string, { queue: Queue; dlq: Queue }>();
    for (const definition of QUEUES) {
      const dlq = new Queue(this, `${definition.name}-dlq`, {
        queueName: `${config.prefix}-${definition.name}-dlq`,
        retentionPeriod: Duration.days(14),
        encryption: QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const queue = new Queue(this, definition.name, {
        queueName: `${config.prefix}-${definition.name}`,
        visibilityTimeout: Duration.seconds(definition.visibilitySeconds),
        retentionPeriod: Duration.days(4),
        deadLetterQueue: { queue: dlq, maxReceiveCount: definition.maxReceiveCount },
        encryption: QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      queues.set(definition.name, { queue, dlq });

      const notify = new SnsAction(alarmTopic);
      new Alarm(this, `${definition.name}-oldest`, {
        alarmName: `${config.prefix}-${definition.name}-oldest-message`,
        alarmDescription: `Messages in ${definition.name} are waiting too long: consumers stuck or too slow`,
        metric: queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1) }),
        threshold: definition.alarms.oldestMessageSeconds,
        evaluationPeriods: 3,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);
      new Alarm(this, `${definition.name}-dlq-depth`, {
        alarmName: `${config.prefix}-${definition.name}-dlq`,
        alarmDescription: `Messages failed in ${definition.name} and are parked in its DLQ`,
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
        threshold: definition.alarms.dlqMessages,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);
    }
    this.queues = queues;

    // --- Schedules (F18): each entry puts its message on its queue; a normal consumer handles it.
    const schedules = loadSchedules();
    if (schedules.length > 0) {
      const group = new CfnScheduleGroup(this, 'ScheduleGroup', { name: config.prefix });
      const role = new Role(this, 'SchedulerRole', {
        assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
        description: 'EventBridge Scheduler: send scheduled messages to helium-backend queues',
      });
      for (const schedule of schedules) {
        const target = queues.get(schedule.queue);
        if (target === undefined)
          throw new Error(`Schedule ${schedule.name} targets unknown queue ${schedule.queue}`);
        role.addToPolicy(
          new PolicyStatement({ actions: ['sqs:SendMessage'], resources: [target.queue.queueArn] }),
        );
        new CfnSchedule(this, `schedule-${schedule.name}`, {
          name: schedule.name,
          groupName: group.ref,
          description: schedule.description,
          scheduleExpression: schedule.scheduleExpression,
          scheduleExpressionTimezone: schedule.timezone,
          flexibleTimeWindow: { mode: 'OFF' },
          target: {
            arn: target.queue.queueArn,
            roleArn: role.roleArn,
            input: schedule.input,
            retryPolicy: { maximumRetryAttempts: 3, maximumEventAgeInSeconds: 300 },
          },
        });
      }
    }

    // --- DocumentDB: the existing cluster lets the services in.
    SecurityGroup.fromSecurityGroupId(this, 'DocumentDb', config.documentDbSecurityGroupId).addIngressRule(
      Peer.securityGroupId(servicesSecurityGroup.securityGroupId),
      Port.tcp(27017),
      'helium-backend tasks',
    );

    this.templateOptions.description = `helium-backend ${config.name}: Valkey, queues, schedules, DocumentDB access`;
  }
}
