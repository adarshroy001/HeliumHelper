import { Module } from '@nestjs/common';
import { AuthModule } from './common/auth/index.js';
import { ConfigModule } from './config/index.js';
import { DatabaseModule } from './infrastructure/database/index.js';
import { HealthModule } from './infrastructure/health/health.module.js';
import { RedisModule } from './infrastructure/redis/index.js';
import { HttpErrorsModule } from './infrastructure/http/http-errors.module.js';
import { LoggerModule } from './infrastructure/logger/logger.module.js';
import { RequestContextModule } from './infrastructure/request-context/request-context.module.js';

/** Root module of the API process: composes infrastructure and business modules. */
@Module({
  imports: [
    ConfigModule,
    RequestContextModule,
    LoggerModule,
    HttpErrorsModule,
    AuthModule,
    DatabaseModule,
    RedisModule,
    HealthModule,
  ],
})
export class AppModule {}
