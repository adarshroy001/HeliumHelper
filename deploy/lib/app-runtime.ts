import { Duration } from 'aws-cdk-lib';
import type { IRepository } from 'aws-cdk-lib/aws-ecr';
import { ContainerImage, type HealthCheck, Secret as EcsSecret } from 'aws-cdk-lib/aws-ecs';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { EnvironmentConfig } from '../config/environments.ts';
import type { AppSecrets } from './foundation-stack.ts';

/** What every container of the app needs from the other stacks. */
export interface AppRuntime {
  readonly config: EnvironmentConfig;
  readonly repository: IRepository;
  /** The image tag to run: the git commit SHA the pipeline built (`-c imageTag=<sha>`). */
  readonly imageTag: string;
  readonly secrets: AppSecrets;
  readonly redisUrl: string;
  readonly redisAuthToken: ISecret;
  readonly region: string;
  readonly account: string;
}

/** Inside the image (Dockerfile). */
const CA_BUNDLE = '/app/certs/global-bundle.pem';

export function appImage(runtime: AppRuntime): ContainerImage {
  return ContainerImage.fromEcrRepository(runtime.repository, runtime.imageTag);
}

/** Settings and secrets for app config and database access: all a migration task needs. */
export function databaseEnvironment(runtime: AppRuntime) {
  return {
    environment: {
      NODE_ENV: 'production',
      APP_ENV: runtime.config.name,
      LOG_LEVEL: 'info',
      MONGO_TLS_CA_FILE: CA_BUNDLE,
    },
    secrets: {
      MONGO_MAIN_URI: EcsSecret.fromSecretsManager(runtime.secrets.mongoMainUri),
      MONGO_MESSAGING_URI: EcsSecret.fromSecretsManager(runtime.secrets.mongoMessagingUri),
    },
  };
}

/** Everything the API and the worker read (src/config). Secrets come from Secrets Manager, never plain text. */
export function serviceEnvironment(runtime: AppRuntime) {
  const database = databaseEnvironment(runtime);
  return {
    environment: {
      ...database.environment,
      AWS_REGION: runtime.region,
      REDIS_URL: runtime.redisUrl,
      SQS_QUEUE_URL_PREFIX: `https://sqs.${runtime.region}.amazonaws.com/${runtime.account}/${runtime.config.prefix}-`,
      SQS_FAIR_QUEUES: 'true',
    },
    secrets: {
      ...database.secrets,
      AUTH_CALLER_SECRETS: EcsSecret.fromSecretsManager(runtime.secrets.authCallerSecrets),
      REDIS_AUTH_TOKEN: EcsSecret.fromSecretsManager(runtime.redisAuthToken),
    },
  };
}

/** The container's own liveness check, the same as the image's HEALTHCHECK. */
export function liveness(port: number): HealthCheck {
  return {
    command: [
      'CMD',
      'node',
      '-e',
      `fetch('http://127.0.0.1:${String(port)}/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
    ],
    interval: Duration.seconds(15),
    timeout: Duration.seconds(5),
    retries: 3,
    startPeriod: Duration.seconds(30),
  };
}
