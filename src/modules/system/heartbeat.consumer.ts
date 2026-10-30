import { PinoLogger } from 'nestjs-pino';
import type { z } from 'zod';
import {
  ack,
  Consumer,
  type MessageHandler,
  type ReceivedMessage,
} from '../../infrastructure/queue/index.js';
import { heartbeatTick, SYSTEM_JOBS_QUEUE } from './system.messages.js';

type HeartbeatTick = z.infer<typeof heartbeatTick.schema>;

/** Logs each heartbeat with how late it arrived. An alarm can watch for the line going missing. */
@Consumer({ queue: SYSTEM_JOBS_QUEUE, message: heartbeatTick, concurrency: 1 })
export class HeartbeatConsumer implements MessageHandler<HeartbeatTick> {
  constructor(private readonly logger: PinoLogger) {
    logger.setContext(HeartbeatConsumer.name);
  }

  handle(_data: HeartbeatTick, { envelope }: ReceivedMessage<HeartbeatTick>) {
    const lagMs = Date.now() - Date.parse(envelope.ts);
    this.logger.info({ scheduledAt: envelope.ts, lagMs }, 'scheduler heartbeat');
    return Promise.resolve(ack());
  }
}
