import { Module } from '@nestjs/common';
import { ConfigModule } from './config/index.js';
import { HealthModule } from './infrastructure/health/health.module.js';
import { HttpErrorsModule } from './infrastructure/http/http-errors.module.js';
import { LoggerModule } from './infrastructure/logger/logger.module.js';
import { RequestContextModule } from './infrastructure/request-context/request-context.module.js';

/** Root module of the API process: composes infrastructure and business modules. */
@Module({
  imports: [ConfigModule, RequestContextModule, LoggerModule, HttpErrorsModule, HealthModule],
})
export class AppModule {}
