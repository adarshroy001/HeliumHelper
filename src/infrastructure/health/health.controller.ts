import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import type { Connection } from 'mongoose';
import { Public } from '../../common/auth/index.js';
import { DB } from '../database/index.js';

/** How long one dependency check may take before it counts as down. */
const CHECK_TIMEOUT_MS = 1_500;

/**
 * Health checks for the load balancer and ECS. Public, served outside the audience prefixes, not access-logged.
 *
 * - `live`: the process is up. It checks no dependencies, so a database outage doesn't make ECS restart
 *   healthy containers.
 * - `ready`: the dependencies this process needs are reachable; 503 when one isn't. Pings both MongoDB
 *   connections; F14 (Redis) and F16 (SQS) add their checks to the list.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
    @InjectConnection(DB.main) private readonly main: Connection,
    @InjectConnection(DB.messaging) private readonly messaging: Connection,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.mongoose.pingCheck('mongoMain', { connection: this.main }).withTimeout(CHECK_TIMEOUT_MS),
      () =>
        this.mongoose
          .pingCheck('mongoMessaging', { connection: this.messaging })
          .withTimeout(CHECK_TIMEOUT_MS),
    ]);
  }
}
