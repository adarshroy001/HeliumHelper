import { Controller, Get } from '@nestjs/common';

/**
 * Liveness only: the process is up and serving HTTP.
 * Readiness checks for each dependency (database, Redis, queues) are added in F10.
 */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
