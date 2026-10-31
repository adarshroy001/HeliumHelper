import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ack, Consumer, type MessageHandler, type Outcome } from '../../../infrastructure/queue/index.js';
import { SuppressionsRepository } from '../data/messaging.repositories.js';
import { keys } from '../messaging.keys.js';
import { UnconfirmedSettler } from '../sending/unconfirmed-settler.js';
import { TemplatesService } from '../templates/templates.service.js';
import { MESSAGING_JOBS_QUEUE, messagingJob, type MessagingJobData } from './messaging-jobs.js';

/** Runs the messaging module's scheduled housekeeping. */
@Consumer({ queue: MESSAGING_JOBS_QUEUE, message: messagingJob, concurrency: 2, visibilitySeconds: 120 })
export class MessagingJobsConsumer implements MessageHandler<MessagingJobData> {
  constructor(
    private readonly templates: TemplatesService,
    private readonly suppressions: SuppressionsRepository,
    private readonly settler: UnconfirmedSettler,
    private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(MessagingJobsConsumer.name);
  }

  async handle({ job }: MessagingJobData): Promise<Outcome> {
    if (job === 'templates-sync') await this.templates.sync();
    else if (job === 'unconfirmed-settle') await this.settler.settle();
    else await this.reloadSuppressions();
    return ack();
  }

  /**
   * Adds every suppressed phone to the Redis mirror, in case Redis lost it. Only adds: a removal is applied to Redis
   * by the API when it happens, so a reload never races an opt-out.
   */
  private async reloadSuppressions(): Promise<void> {
    let total = 0;
    for await (const phones of this.suppressions.allPhones()) {
      await this.redis.sadd(keys.suppressed(), ...phones);
      total += phones.length;
    }
    this.logger.info({ suppressions: total }, 'suppressions reloaded');
  }
}
