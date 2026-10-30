import { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { queueConfig, type QueueConfig } from '../../config/index.js';
import { QueuePublisher } from './queue-publisher.js';

function createSqsClient(config: QueueConfig): SQSClient {
  return new SQSClient({
    region: config.region,
    // ElasticMQ accepts any credentials. In AWS the SDK uses the task role.
    ...(config.endpoint === undefined
      ? {}
      : { endpoint: config.endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }),
  });
}

@Injectable()
class SqsShutdown implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

/** The SQS client and `QueuePublisher`, available app-wide (ADR-0006). */
@Global()
@Module({
  providers: [
    { provide: SQSClient, inject: [queueConfig.KEY], useFactory: createSqsClient },
    QueuePublisher,
    SqsShutdown,
  ],
  exports: [SQSClient, QueuePublisher],
})
export class QueueModule {}
