import { Module } from '@nestjs/common';
import { HealthModule } from './infrastructure/health/health.module.js';

/** Root module of the API process: composes infrastructure and business modules. */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
