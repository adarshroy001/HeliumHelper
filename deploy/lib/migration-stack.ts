import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import {
  CpuArchitecture,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs';
import type { ILogGroup } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { type AppRuntime, appImage, databaseEnvironment } from './app-runtime.ts';

export interface MigrationStackProps extends StackProps {
  readonly runtime: AppRuntime;
  readonly vpc: IVpc;
  readonly clusterName: string;
  readonly logGroup: ILogGroup;
  readonly securityGroup: ISecurityGroup;
}

/**
 * The migration task (F13, F25): `node dist/migrate.js up` on a given image. A release deploys this stack with
 * the new image, runs the task, and deploys the services only if it succeeds. Its own stack, so the task
 * definition can move to the new image before the services do.
 */
export class MigrationStack extends Stack {
  constructor(scope: Construct, id: string, props: MigrationStackProps) {
    super(scope, id, props);
    const { runtime } = props;

    const task = new FargateTaskDefinition(this, 'Task', {
      family: `${runtime.config.prefix}-migrate`,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.X86_64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });
    task.addContainer('migrate', {
      image: appImage(runtime),
      command: ['node', '--enable-source-maps', 'dist/migrate.js', 'up'],
      ...databaseEnvironment(runtime),
      logging: LogDrivers.awsLogs({ logGroup: props.logGroup, streamPrefix: 'migrate' }),
      essential: true,
    });

    // What `aws ecs run-task` needs; the release workflow reads these outputs.
    new CfnOutput(this, 'TaskDefinitionArn', { value: task.taskDefinitionArn });
    new CfnOutput(this, 'ClusterName', { value: props.clusterName });
    new CfnOutput(this, 'Subnets', { value: props.vpc.privateSubnets.map((s) => s.subnetId).join(',') });
    new CfnOutput(this, 'SecurityGroup', { value: props.securityGroup.securityGroupId });

    this.templateOptions.description = `helium-backend ${runtime.config.name}: migration task`;
  }
}
