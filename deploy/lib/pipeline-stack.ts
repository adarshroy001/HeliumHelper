import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { IRepository } from 'aws-cdk-lib/aws-ecr';
import {
  type IOpenIdConnectProvider,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
} from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { type EnvironmentConfig, GITHUB_REPOSITORY } from '../config/environments.ts';

export interface PipelineStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly repository: IRepository;
}

const GITHUB_OIDC = 'token.actions.githubusercontent.com';

/**
 * Lets GitHub Actions deploy this environment without stored AWS keys (F26): an OIDC trust limited to this
 * repository (staging: the `main` branch; production: the `production` GitHub environment, which requires an
 * approval) and a role that can push the image, deploy the CDK stacks and run the migration task. Deployed
 * once by an administrator, then by the pipeline itself.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { config } = props;
    const account = Stack.of(this).account;
    const region = Stack.of(this).region;

    const provider: IOpenIdConnectProvider =
      config.githubOidcProvider === 'create'
        ? new OpenIdConnectProvider(this, 'GitHubOidc', {
            url: `https://${GITHUB_OIDC}`,
            clientIds: ['sts.amazonaws.com'],
          })
        : OpenIdConnectProvider.fromOpenIdConnectProviderArn(
            this,
            'GitHubOidc',
            `arn:aws:iam::${account}:oidc-provider/${GITHUB_OIDC}`,
          );

    const subject =
      config.name === 'production'
        ? `repo:${GITHUB_REPOSITORY}:environment:production`
        : `repo:${GITHUB_REPOSITORY}:ref:refs/heads/main`;
    const role = new Role(this, 'DeployRole', {
      roleName: `${config.prefix}-github-deploy`,
      description: `GitHub Actions (${GITHUB_REPOSITORY}) deploys ${config.name}`,
      assumedBy: new WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { [`${GITHUB_OIDC}:aud`]: 'sts.amazonaws.com', [`${GITHUB_OIDC}:sub`]: subject },
      }),
    });

    // Push the release image.
    props.repository.grantPullPush(role);
    role.addToPolicy(new PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));

    // `cdk deploy` works through the roles `cdk bootstrap` created; the pipeline may only assume those.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${account}:role/cdk-*-${account}-${region}`],
      }),
    );

    // Run the migration task and read its result and outputs.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [`arn:aws:ecs:${region}:${account}:task-definition/${config.prefix}-migrate:*`],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ecs:DescribeTasks'],
        resources: [`arn:aws:ecs:${region}:${account}:task/${config.prefix}/*`],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${account}:role/${config.prefix}-migration-*`],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${region}:${account}:stack/${config.prefix}-*/*`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', {
      value: role.roleArn,
      description: `Set as the AWS_DEPLOY_ROLE_ARN variable of the GitHub "${config.name}" environment`,
    });
    this.templateOptions.description = `helium-backend ${config.name}: GitHub Actions deploy role (OIDC)`;
  }
}
