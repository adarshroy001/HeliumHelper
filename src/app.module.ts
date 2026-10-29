import { Module } from '@nestjs/common';
import { ConfigModule } from './config/index.js';
import { HealthModule } from './infrastructure/health/health.module.js';

/** Root module of the API process: composes infrastructure and business modules. */
@Module({
  imports: [ConfigModule, HealthModule],
})
export class AppModule {}
