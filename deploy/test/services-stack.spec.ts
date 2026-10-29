import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { stagingStacks } from './stacks.ts';

const { services, migration } = stagingStacks();
const template = Template.fromStack(services);

type ContainerDefinition = {
  Name: string;
  Command?: string[];
  Environment?: { Name: string; Value: unknown }[];
  Secrets?: { Name: string }[];
  StopTimeout?: number;
};

function container(name: string): ContainerDefinition {
  const tasks = template.findResources('AWS::ECS::TaskDefinition');
  for (const task of Object.values(tasks)) {
    const definitions = (task as { Properties: { ContainerDefinitions: ContainerDefinition[] } }).Properties
      .ContainerDefinitions;
    const found = definitions.find((d) => d.Name === name);
    if (found !== undefined) return found;
  }
  throw new Error(`no container ${name}`);
}

describe('ServicesStack', () => {
  it('puts the API behind an internal load balancer that only the callers can reach', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: 'helium-staging-api-alb',
      SecurityGroupIngress: [
        Match.objectLike({ SourceSecurityGroupId: 'sg-00000000000000002', FromPort: 80 }),
      ],
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/health/ready',
      Port: 3000,
    });
  });

  it('rolls deployments back automatically and gives tasks no public IP', () => {
    for (const name of ['helium-staging-api', 'helium-staging-worker']) {
      template.hasResourceProperties('AWS::ECS::Service', {
        ServiceName: name,
        DeploymentConfiguration: Match.objectLike({
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
          MinimumHealthyPercent: 100,
        }),
        NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
      });
    }
  });

  it('passes secrets from Secrets Manager, never as plain environment values', () => {
    for (const name of ['api', 'worker']) {
      const definition = container(name);
      const secretNames = (definition.Secrets ?? []).map((s) => s.Name).sort();
      const envNames = (definition.Environment ?? []).map((e) => e.Name);

      expect(secretNames).toEqual([
        'AUTH_CALLER_SECRETS',
        'MONGO_MAIN_URI',
        'MONGO_MESSAGING_URI',
        'REDIS_AUTH_TOKEN',
      ]);
      expect(envNames).not.toContain('AUTH_CALLER_SECRETS');
      expect(envNames).toContain('SQS_QUEUE_URL_PREFIX');
    }
  });

  it('runs the worker command with every consumer and time to finish in-flight messages', () => {
    const worker = container('worker');

    expect(worker.Command).toEqual(['node', '--enable-source-maps', 'dist/worker.js']);
    expect(worker.Environment).toEqual(expect.arrayContaining([{ Name: 'WORKER_QUEUES', Value: '*' }]));
    expect(worker.StopTimeout).toBe(60);
  });

  it('lets only the worker consume from the queues', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).map((p) => JSON.stringify(p));
    const consumers = policies.filter((p) => p.includes('sqs:ReceiveMessage'));

    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toContain('WorkerTaskTaskRole');
  });

  it('scales each service between its minimum and maximum', () => {
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 1,
      MaxCapacity: 3,
    });
  });
});

describe('MigrationStack', () => {
  it('defines the migration task on the release image, with database access only', () => {
    const migrate = Template.fromStack(migration);

    migrate.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'helium-staging-migrate',
      ContainerDefinitions: [
        Match.objectLike({
          Command: ['node', '--enable-source-maps', 'dist/migrate.js', 'up'],
          Secrets: [
            Match.objectLike({ Name: 'MONGO_MAIN_URI' }),
            Match.objectLike({ Name: 'MONGO_MESSAGING_URI' }),
          ],
        }),
      ],
    });
    expect(Object.keys(migrate.findOutputs('*')).sort()).toEqual([
      'ClusterName',
      'SecurityGroup',
      'Subnets',
      'TaskDefinitionArn',
    ]);
  });
});
