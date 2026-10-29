import { App } from 'aws-cdk-lib';
import { ENVIRONMENTS } from '../config/environments.ts';
import { DataStack } from '../lib/data-stack.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';

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
  return { app, config, env, foundation, data };
}
