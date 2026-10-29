import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { type ISecurityGroup, type IVpc, Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import {
  type ICluster,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerCertificate,
  Protocol,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { ILogGroup } from 'aws-cdk-lib/aws-logs';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { type AppRuntime, appImage, liveness, serviceEnvironment } from './app-runtime.ts';

export interface ServicesStackProps extends StackProps {
  readonly runtime: AppRuntime;
  readonly vpc: IVpc;
  readonly cluster: ICluster;
  readonly logGroups: { readonly api: ILogGroup; readonly worker: ILogGroup };
  readonly servicesSecurityGroup: ISecurityGroup;
  readonly queues: ReadonlyMap<string, { readonly queue: Queue; readonly dlq: Queue }>;
  readonly alarmTopic: ITopic;
}

const API_PORT = 3000;
const WORKER_HEALTH_PORT = 3001;
const runtimePlatform = {
  cpuArchitecture: CpuArchitecture.X86_64,
  operatingSystemFamily: OperatingSystemFamily.LINUX,
};

/**
 * The running services of one environment (F25): the API behind an internal load balancer that only the
 * configured callers can reach, and one worker service running every consumer. Both roll back automatically
 * when a deployment's tasks don't become healthy.
 */
export class ServicesStack extends Stack {
  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);
    const { runtime, vpc, cluster } = props;
    // Imported by ID, so the rules CDK adds (load balancer → tasks) live in this stack, not the foundation's.
    const servicesSecurityGroup = SecurityGroup.fromSecurityGroupId(
      this,
      'ServicesSecurityGroup',
      props.servicesSecurityGroup.securityGroupId,
    );
    const { config } = runtime;
    const queues = [...props.queues.values()];
    const subnets = { subnets: vpc.privateSubnets };
    const shared = serviceEnvironment(runtime);

    // --- API
    const apiTask = new FargateTaskDefinition(this, 'ApiTask', {
      family: `${config.prefix}-api`,
      cpu: config.api.cpu,
      memoryLimitMiB: config.api.memoryMiB,
      runtimePlatform,
    });
    apiTask.addContainer('api', {
      image: appImage(runtime),
      secrets: shared.secrets,
      environment: { ...shared.environment, PORT: String(API_PORT) },
      portMappings: [{ containerPort: API_PORT }],
      healthCheck: liveness(API_PORT),
      logging: LogDrivers.awsLogs({ logGroup: props.logGroups.api, streamPrefix: 'api' }),
      // Requests in flight finish on SIGTERM; the load balancer has already stopped sending new ones.
      stopTimeout: Duration.seconds(30),
    });
    for (const { queue } of queues) queue.grantSendMessages(apiTask.taskRole);

    const api = new FargateService(this, 'Api', {
      serviceName: `${config.prefix}-api`,
      cluster,
      taskDefinition: apiTask,
      desiredCount: config.api.minCount,
      securityGroups: [servicesSecurityGroup],
      vpcSubnets: subnets,
      assignPublicIp: false,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(60),
    });
    api
      .autoScaleTaskCount({ minCapacity: config.api.minCount, maxCapacity: config.api.maxCount })
      .scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    // Internal only: reachable from inside the VPC, and only by the configured callers.
    const albSecurityGroup = new SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      securityGroupName: `${config.prefix}-api-alb`,
      description: 'helium-backend API load balancer: callers only',
      allowAllOutbound: false,
    });
    const listenerPort = config.certificateArn === undefined ? 80 : 443;
    for (const group of config.callers.securityGroupIds) {
      albSecurityGroup.addIngressRule(Peer.securityGroupId(group), Port.tcp(listenerPort), 'caller');
    }
    for (const cidr of config.callers.cidrs) {
      albSecurityGroup.addIngressRule(Peer.ipv4(cidr), Port.tcp(listenerPort), 'caller');
    }

    const alb = new ApplicationLoadBalancer(this, 'ApiLoadBalancer', {
      loadBalancerName: `${config.prefix}-api`,
      vpc,
      vpcSubnets: subnets,
      internetFacing: false,
      securityGroup: albSecurityGroup,
    });
    const listener = alb.addListener('Listener', {
      port: listenerPort,
      protocol: config.certificateArn === undefined ? ApplicationProtocol.HTTP : ApplicationProtocol.HTTPS,
      ...(config.certificateArn === undefined
        ? {}
        : { certificates: [ListenerCertificate.fromArn(config.certificateArn)] }),
      open: false,
    });
    const targets = listener.addTargets('Api', {
      port: API_PORT,
      protocol: ApplicationProtocol.HTTP,
      targets: [api],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: '/health/ready',
        protocol: Protocol.HTTP,
        interval: Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    new Alarm(this, 'ApiUnhealthy', {
      alarmName: `${config.prefix}-api-no-healthy-targets`,
      alarmDescription: 'The API load balancer has no healthy tasks: readiness fails or tasks are down',
      metric: targets.metrics.healthyHostCount({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));

    // --- Worker
    const workerTask = new FargateTaskDefinition(this, 'WorkerTask', {
      family: `${config.prefix}-worker`,
      cpu: config.worker.cpu,
      memoryLimitMiB: config.worker.memoryMiB,
      runtimePlatform,
    });
    workerTask.addContainer('worker', {
      image: appImage(runtime),
      command: ['node', '--enable-source-maps', 'dist/worker.js'],
      secrets: shared.secrets,
      environment: {
        ...shared.environment,
        WORKER_QUEUES: '*',
        WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
        HEALTHCHECK_PORT: String(WORKER_HEALTH_PORT),
      },
      healthCheck: liveness(WORKER_HEALTH_PORT),
      logging: LogDrivers.awsLogs({ logGroup: props.logGroups.worker, streamPrefix: 'worker' }),
      // The worker finishes in-flight messages (up to 25 s) before it exits.
      stopTimeout: Duration.seconds(60),
    });
    for (const { queue, dlq } of queues) {
      queue.grantConsumeMessages(workerTask.taskRole);
      queue.grantSendMessages(workerTask.taskRole);
      dlq.grantSendMessages(workerTask.taskRole);
    }

    const worker = new FargateService(this, 'Worker', {
      serviceName: `${config.prefix}-worker`,
      cluster,
      taskDefinition: workerTask,
      desiredCount: config.worker.minCount,
      securityGroups: [servicesSecurityGroup],
      vpcSubnets: subnets,
      assignPublicIp: false,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    worker
      .autoScaleTaskCount({ minCapacity: config.worker.minCount, maxCapacity: config.worker.maxCount })
      .scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    new CfnOutput(this, 'ApiUrl', {
      value: `${config.certificateArn === undefined ? 'http' : 'https'}://${alb.loadBalancerDnsName}`,
      description: 'Internal API URL for HeliumAdmin',
    });
    this.templateOptions.description = `helium-backend ${config.name}: API and worker services`;
  }
}
