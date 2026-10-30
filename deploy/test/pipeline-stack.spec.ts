import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS, type EnvironmentConfig } from '../config/environments.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';
import { PipelineStack } from '../lib/pipeline-stack.ts';

function pipelineFor(name: EnvironmentConfig['name'], change: Partial<EnvironmentConfig> = {}) {
  const base = ENVIRONMENTS.find((e) => e.name === name);
  if (base === undefined) throw new Error(`no ${name}`);
  const config = { ...base, ...change };
  const app = new App();
  const env = { account: '123456789012', region: config.region };
  const foundation = new FoundationStack(app, 'f', { env, config });
  return Template.fromStack(new PipelineStack(app, 'p', { env, config, repository: foundation.repository }));
}

// Synthesized once, up front: the first synthesis loads aws-cdk-lib, which takes seconds.
const staging = pipelineFor('staging');
const production = pipelineFor('production');
const stagingWithExistingProvider = pipelineFor('staging', { githubOidcProvider: 'existing' });
const providers = (template: Template) =>
  Object.keys(template.findResources('Custom::AWSCDKOpenIdConnectProvider'));

const trust = (subject: string) =>
  Match.objectLike({
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: [
        Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub': subject,
            },
          },
        }),
      ],
    }),
  });

describe('PipelineStack', () => {
  it('lets only the main branch deploy staging', () => {
    staging.hasResourceProperties(
      'AWS::IAM::Role',
      trust('repo:adarshroy001/HeliumHelper:ref:refs/heads/main'),
    );
  });

  it('lets only the approved production environment deploy production', () => {
    production.hasResourceProperties(
      'AWS::IAM::Role',
      trust('repo:adarshroy001/HeliumHelper:environment:production'),
    );
  });

  it('creates the OIDC provider only when asked to', () => {
    expect(providers(staging)).toHaveLength(1);
    expect(providers(stagingWithExistingProvider)).toHaveLength(0);
  });

  it('may run only the migration task and assume only the CDK bootstrap roles', () => {
    const policy = JSON.stringify(staging.findResources('AWS::IAM::Policy'));

    expect(policy).toContain('task-definition/helium-staging-migrate:*');
    expect(policy).toContain('role/cdk-*-123456789012-ap-south-1');
    expect(policy).toContain('"iam:PassedToService":"ecs-tasks.amazonaws.com"');
    expect(policy).not.toContain('"Action":"*"');
  });
});
