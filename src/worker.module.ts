import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ConfigModule } from './config/index.js';
import { BlobModule } from './infrastructure/blob/index.js';
import { DatabaseModule } from './infrastructure/database/index.js';
import { HealthModule } from './infrastructure/health/health.module.js';
import { HttpErrorsModule } from './infrastructure/http/http-errors.module.js';
import { LoggerModule } from './infrastructure/logger/logger.module.js';
import { ConsumerRunner } from './infrastructure/queue/consumer/consumer-runner.js';
import { LocalScheduler, QueueModule, SCHEDULES as SCHEDULES_TOKEN } from './infrastructure/queue/index.js';
import { RedisModule } from './infrastructure/redis/index.js';
import { RequestContextModule } from './infrastructure/request-context/request-context.module.js';
import { MessagingModule } from './modules/messaging/index.js';
import { SystemModule } from './modules/system/index.js';
import { SCHEDULES } from './schedules.js';

/**
 * Root module of the worker process: the same infrastructure as the API, the consumer runner, the local
 * scheduler, and only a health endpoint over HTTP. Business modules that own consumers are imported here.
 */
@Module({
  imports: [
    ConfigModule,
    RequestContextModule,
    LoggerModule,
    HttpErrorsModule,
    DatabaseModule,
    BlobModule,
    RedisModule,
    QueueModule,
    DiscoveryModule,
    HealthModule,
    SystemModule,
    MessagingModule,
  ],
  providers: [ConsumerRunner, LocalScheduler, { provide: SCHEDULES_TOKEN, useValue: SCHEDULES }],
})
export class WorkerModule {}
