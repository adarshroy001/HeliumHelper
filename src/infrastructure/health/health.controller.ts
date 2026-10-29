import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { Public } from '../../common/auth/index.js';

/**
 * Health checks for the load balancer and ECS. Public, served outside the audience prefixes, not access-logged.
 *
 * - `live`: the process is up. It checks no dependencies, so a database outage doesn't make ECS restart
 *   healthy containers.
 * - `ready`: the dependencies this process needs are reachable; 503 when one isn't. F12 (MongoDB), F14 (Redis)
 *   and F16 (SQS) add their checks to the list.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }
}
