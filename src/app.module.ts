import { Module } from '@nestjs/common';
import { ConfigModule } from './config/index.js';
import { HealthModule } from './infrastructure/health/health.module.js';
import { LoggerModule } from './infrastructure/logger/logger.module.js';
import { RequestContextModule } from './infrastructure/request-context/request-context.module.js';

/** Root module of the API process: composes infrastructure and business modules. */
@Module({
  imports: [ConfigModule, RequestContextModule, LoggerModule, HealthModule],
})
export class AppModule {}
