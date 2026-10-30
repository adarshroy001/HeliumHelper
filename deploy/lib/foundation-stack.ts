import { Annotations, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { type IVpc, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import { Cluster, ContainerInsights } from 'aws-cdk-lib/aws-ecs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config/environments.ts';

export interface FoundationStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/** The secrets every process reads. Values are set by hand (see deploy/README.md), except where generated. */
export interface AppSecrets {
  /** `AUTH_CALLER_SECRETS`: generated, `{"helium-admin":"<random>"}`. HeliumAdmin reads its own key from it. */
  readonly authCallerSecrets: Secret;
  readonly mongoMainUri: Secret;
  readonly mongoMessagingUri: Secret;
}

/**
 * The base of one environment (F23): the existing VPC, the image repository, the ECS cluster, log groups,
 * secrets, the services' security group and the alarm topic. Changes rarely; other stacks build on it.
 */
export class FoundationStack extends Stack {
  readonly vpc: IVpc;
  readonly repository: Repository;
  readonly cluster: Cluster;
  readonly logGroups: { readonly api: LogGroup; readonly worker: LogGroup; readonly migrate: LogGroup };
  readonly secrets: AppSecrets;
  /** Attached to every API, worker and migration task. */
  readonly servicesSecurityGroup: SecurityGroup;
  readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.vpc = Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: config.vpc.vpcId,
      availabilityZones: [...config.vpc.availabilityZones],
      privateSubnetIds: [...config.vpc.privateSubnetIds],
    });
    // Route tables matter only for resources that change routing (VPC endpoints), which these stacks don't add.
    Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-ec2:noSubnetRouteTableId',
      'No routing changes are made in the existing VPC',
    );

    this.repository = new Repository(this, 'Repository', {
      repositoryName: `${config.prefix}-backend`,
      imageTagMutability: TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [{ description: 'Keep the last 50 images', maxImageCount: 50 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.cluster = new Cluster(this, 'Cluster', {
      clusterName: config.prefix,
      vpc: this.vpc,
      containerInsightsV2: ContainerInsights.ENABLED,
    });

    const logGroup = (name: string) =>
      new LogGroup(this, `${name}Logs`, {
        logGroupName: `/helium/${config.name}/${name.toLowerCase()}`,
        retention: config.logRetention,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    this.logGroups = { api: logGroup('Api'), worker: logGroup('Worker'), migrate: logGroup('Migrate') };

    const secret = (id: string, name: string, description: string) =>
      new Secret(this, id, {
        secretName: `helium/${config.name}/${name}`,
        description,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    this.secrets = {
      authCallerSecrets: new Secret(this, 'AuthCallerSecrets', {
        secretName: `helium/${config.name}/auth-caller-secrets`,
        description: 'AUTH_CALLER_SECRETS: each caller service and the secret it signs tokens with',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({}),
          generateStringKey: 'helium-admin',
          passwordLength: 48,
          excludePunctuation: true,
        },
        removalPolicy: RemovalPolicy.RETAIN,
      }),
      mongoMainUri: secret(
        'MongoMainUri',
        'mongo-main-uri',
        'MONGO_MAIN_URI: the read-only user on the Helium DB',
      ),
      mongoMessagingUri: secret(
        'MongoMessagingUri',
        'mongo-messaging-uri',
        'MONGO_MESSAGING_URI: the read-write user on helium_messaging',
      ),
    };

    this.servicesSecurityGroup = new SecurityGroup(this, 'ServicesSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${config.prefix}-services`,
      description: 'helium-backend API, worker and migration tasks',
      allowAllOutbound: true,
    });

    this.alarmTopic = new Topic(this, 'Alarms', { topicName: `${config.prefix}-alarms` });
    if (config.alarmEmail !== undefined)
      this.alarmTopic.addSubscription(new EmailSubscription(config.alarmEmail));

    this.templateOptions.description = `helium-backend ${config.name}: foundation (VPC refs, ECR, ECS, logs, secrets)`;
  }
}
