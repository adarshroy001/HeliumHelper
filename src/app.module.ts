import { Module } from '@nestjs/common';
import { AuthModule } from './common/auth/index.js';
import { ConfigModule } from './config/index.js';
import { BlobModule } from './infrastructure/blob/index.js';
import { DatabaseModule } from './infrastructure/database/index.js';
import { HealthModule } from './infrastructure/health/health.module.js';
import { QueueModule } from './infrastructure/queue/index.js';
import { RateLimitModule } from './infrastructure/rate-limit/index.js';
import { RedisModule } from './infrastructure/redis/index.js';
import { HttpErrorsModule } from './infrastructure/http/http-errors.module.js';
import { LoggerModule } from './infrastructure/logger/logger.module.js';
import { RequestContextModule } from './infrastructure/request-context/request-context.module.js';
import { CampaignsApiModule } from './modules/campaigns/index.js';
import { MessagingApiModule } from './modules/messaging/index.js';

/** Root module of the API process: composes infrastructure and business modules. */
@Module({
  imports: [
    ConfigModule,
    RequestContextModule,
    LoggerModule,
    HttpErrorsModule,
    AuthModule,
    DatabaseModule,
    BlobModule,
    RedisModule,
    QueueModule,
    // After AuthModule: its guards run first, so limits count per verified caller.
    RateLimitModule,
    HealthModule,
    MessagingApiModule,
    CampaignsApiModule,
  ],
})
export class AppModule {}
