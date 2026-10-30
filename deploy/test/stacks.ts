import { App } from 'aws-cdk-lib';
import { ENVIRONMENTS } from '../config/environments.ts';
import type { AppRuntime } from '../lib/app-runtime.ts';
import { DataStack } from '../lib/data-stack.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';
import { MigrationStack } from '../lib/migration-stack.ts';
import { ServicesStack } from '../lib/services-stack.ts';

/** The staging stacks, synthesized for tests with a real-looking account. */
export function stagingStacks() {
  const config = ENVIRONMENTS.find((e) => e.name === 'staging');
  if (config === undefined) throw new Error('no staging environment');
  const app = new App();
  const env = { account: '123456789012', region: config.region };
  const foundation = new FoundationStack(app, 'test-foundation', { env, config });
  const data = new DataStack(app, 'test-data', {
    env,
    config,
    vpc: foundation.vpc,
    servicesSecurityGroup: foundation.servicesSecurityGroup,
    alarmTopic: foundation.alarmTopic,
  });
  const runtime: AppRuntime = {
    config,
    repository: foundation.repository,
    imageTag: 'abc1234',
    secrets: foundation.secrets,
    redisUrl: data.redisUrl,
    redisAuthToken: data.redisAuthToken,
    region: env.region,
    account: env.account,
  };
  const migration = new MigrationStack(app, 'test-migration', {
    env,
    runtime,
    vpc: foundation.vpc,
    clusterName: foundation.cluster.clusterName,
    logGroup: foundation.logGroups.migrate,
    securityGroup: foundation.servicesSecurityGroup,
  });
  const services = new ServicesStack(app, 'test-services', {
    env,
    runtime,
    vpc: foundation.vpc,
    cluster: foundation.cluster,
    logGroups: foundation.logGroups,
    servicesSecurityGroup: foundation.servicesSecurityGroup,
    queues: data.queues,
    alarmTopic: foundation.alarmTopic,
  });
  return { app, config, env, foundation, data, migration, services };
}
