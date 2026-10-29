import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS, hasPlaceholders } from '../config/environments.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';

const staging = ENVIRONMENTS.find((e) => e.name === 'staging');
if (staging === undefined) throw new Error('no staging environment');

const template = Template.fromStack(
  new FoundationStack(new App(), 'test-foundation', {
    env: { account: '123456789012', region: staging.region },
    config: staging,
  }),
);

describe('FoundationStack', () => {
  it('creates an immutable, scanned image repository that survives stack deletion', () => {
    template.hasResource('AWS::ECR::Repository', {
      Properties: {
        RepositoryName: 'helium-staging-backend',
        ImageTagMutability: 'IMMUTABLE',
        ImageScanningConfiguration: { ScanOnPush: true },
      },
      DeletionPolicy: 'Retain',
    });
  });

  it('creates the cluster with Container Insights and one log group per process', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: 'helium-staging' });
    for (const name of ['api', 'worker', 'migrate']) {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/helium/staging/${name}`,
        RetentionInDays: 14,
      });
    }
  });

  it('generates the caller secret and creates the database URI secrets empty', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'helium/staging/auth-caller-secrets',
      GenerateSecretString: Match.objectLike({ GenerateStringKey: 'helium-admin', ExcludePunctuation: true }),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'helium/staging/mongo-main-uri' });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'helium/staging/mongo-messaging-uri',
    });
  });

  it('flags environments that still have placeholder values', () => {
    expect(hasPlaceholders(staging)).toBe(true);
    expect(
      hasPlaceholders({
        ...staging,
        account: '123456789012',
        vpc: { ...staging.vpc, vpcId: 'vpc-0abc123', privateSubnetIds: ['subnet-0abc'] },
        documentDbSecurityGroupId: 'sg-0abc',
        callers: { securityGroupIds: ['sg-0def'], cidrs: [] },
      }),
    ).toBe(false);
  });
});
