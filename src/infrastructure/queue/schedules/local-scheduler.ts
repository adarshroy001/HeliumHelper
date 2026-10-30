import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Cron } from 'croner';
import { PinoLogger } from 'nestjs-pino';
import { appConfig, type AppConfig } from '../../../config/index.js';
import { QueuePublisher } from '../queue-publisher.js';
import type { Schedule } from './schedule.js';

/** Injection token for the schedule registry (`src/schedules.ts`). */
export const SCHEDULES = Symbol('SCHEDULES');

/**
 * Local stand-in for EventBridge Scheduler: on a developer's machine (`APP_ENV=local`, not in tests), the
 * worker publishes each schedule's message on its timetable. Deployed environments use EventBridge (F24) and
 * this does nothing.
 */
@Injectable()
export class LocalScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly jobs: Cron[] = [];

  constructor(
    @Inject(SCHEDULES) private readonly schedules: readonly Schedule<unknown>[],
    @Inject(appConfig.KEY) private readonly app: AppConfig,
    private readonly publisher: QueuePublisher,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LocalScheduler.name);
  }

  onApplicationBootstrap(): void {
    if (this.app.appEnv !== 'local' || this.app.nodeEnv === 'test') return;
    for (const schedule of this.schedules) this.jobs.push(this.start(schedule));
    if (this.jobs.length > 0) this.logger.info({ schedules: this.jobs.length }, 'local schedules started');
  }

  onApplicationShutdown(): void {
    for (const job of this.jobs) job.stop();
  }

  /** Starts one schedule's timer. Exposed for tests, which fire it with `job.trigger()`. */
  start(schedule: Schedule<unknown>): Cron {
    return new Cron(schedule.cron, { timezone: schedule.timezone, unref: true, catch: true }, async () => {
      try {
        await this.publisher.publish(schedule.queue, schedule.message, schedule.data);
        this.logger.info({ schedule: schedule.name }, 'schedule fired');
      } catch (err) {
        this.logger.warn({ err, schedule: schedule.name }, 'schedule could not publish');
      }
    });
  }
}
