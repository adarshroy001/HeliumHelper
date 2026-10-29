// The CDK app: every stack of every environment. Run through the CDK CLI (cdk.json), for example
//   pnpm cdk synth                                      check every template (CI does this)
//   pnpm cdk deploy helium-staging-foundation           create or update one stack
import { Annotations, App, Tags } from 'aws-cdk-lib';
import { ENVIRONMENTS, hasPlaceholders } from '../config/environments.ts';
import { DataStack } from '../lib/data-stack.ts';
import { FoundationStack } from '../lib/foundation-stack.ts';

const app = new App();

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

  for (const stack of [foundation, data]) {
    Tags.of(stack).add('project', 'helium-backend');
    Tags.of(stack).add('environment', config.name);
  }
  if (hasPlaceholders(config)) {
    Annotations.of(foundation).addWarning(
      `${config.name} still has placeholder values (TODO(aws) in deploy/config)`,
    );
  }
}

app.synth();
