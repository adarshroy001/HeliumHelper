// The CDK app: every stack of every environment. Run through the CDK CLI (cdk.json), for example
//   pnpm cdk synth                                      check every template (CI does this)
//   pnpm cdk deploy helium-staging-foundation           create or update one stack
import { Annotations, App, Tags } from 'aws-cdk-lib';
import { ENVIRONMENTS, hasPlaceholders } from '../config/environments.ts';
import type { AppRuntime } from '../lib/app-runtime.ts';
import { DataStack } from '../lib/data-stack.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';
import { MigrationStack } from '../lib/migration-stack.ts';
import { ServicesStack } from '../lib/services-stack.ts';

const app = new App();
/** The image the migration and services stacks run: the release workflow passes the commit SHA. */
const imageTag = (app.node.tryGetContext('imageTag') as string | undefined) ?? 'unset';

for (const config of ENVIRONMENTS) {
  const env = { account: config.account, region: config.region };
  const foundation = new FoundationStack(app, `${config.prefix}-foundation`, { env, config });
  const data = new DataStack(app, `${config.prefix}-data`, {
    env,
    config,
    vpc: foundation.vpc,
    servicesSecurityGroup: foundation.servicesSecurityGroup,
    alarmTopic: foundation.alarmTopic,
  });

  const runtime: AppRuntime = {
    config,
    repository: foundation.repository,
    imageTag,
    secrets: foundation.secrets,
    redisUrl: data.redisUrl,
    redisAuthToken: data.redisAuthToken,
    region: config.region,
    account: config.account,
  };
  const migration = new MigrationStack(app, `${config.prefix}-migration`, {
    env,
    runtime,
    vpc: foundation.vpc,
    clusterName: foundation.cluster.clusterName,
    logGroup: foundation.logGroups.migrate,
    securityGroup: foundation.servicesSecurityGroup,
  });
  const services = new ServicesStack(app, `${config.prefix}-services`, {
    env,
    runtime,
    vpc: foundation.vpc,
    cluster: foundation.cluster,
    logGroups: foundation.logGroups,
    servicesSecurityGroup: foundation.servicesSecurityGroup,
    queues: data.queues,
  });

  for (const stack of [foundation, data, migration, services]) {
    Tags.of(stack).add('project', 'helium-backend');
    Tags.of(stack).add('environment', config.name);
  }
  if (imageTag === 'unset') {
    Annotations.of(services).addWarning(
      'No image tag: deploy with -c imageTag=<git sha> (the release workflow does)',
    );
  }
  if (hasPlaceholders(config)) {
    Annotations.of(foundation).addWarning(
      `${config.name} still has placeholder values (TODO(aws) in deploy/config)`,
    );
  }
}

app.synth();
