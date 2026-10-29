import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ConfigModule } from './config/index.js';
import { DatabaseModule } from './infrastructure/database/index.js';
import { HealthModule } from './infrastructure/health/health.module.js';
import { HttpErrorsModule } from './infrastructure/http/http-errors.module.js';
import { LoggerModule } from './infrastructure/logger/logger.module.js';
import { ConsumerRunner } from './infrastructure/queue/consumer/consumer-runner.js';
import { QueueModule } from './infrastructure/queue/index.js';
import { RedisModule } from './infrastructure/redis/index.js';
import { RequestContextModule } from './infrastructure/request-context/request-context.module.js';

/**
 * Root module of the worker process: the same infrastructure as the API, the consumer runner, and only a
 * health endpoint over HTTP. Business modules that own consumers are imported here as they are added.
 */
@Module({
  imports: [
    ConfigModule,
    RequestContextModule,
    LoggerModule,
    HttpErrorsModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    DiscoveryModule,
    HealthModule,
  ],
  providers: [ConsumerRunner],
})
export class WorkerModule {}
