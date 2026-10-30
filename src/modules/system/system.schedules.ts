import { defineSchedule } from '../../infrastructure/queue/index.js';
import { heartbeatTick, SYSTEM_JOBS_QUEUE } from './system.messages.js';

/** Every 5 minutes. If its log line stops appearing, scheduling or the worker is broken. */
export const heartbeatSchedule = defineSchedule({
  name: 'system-heartbeat',
  description: 'Proves the scheduler, the system-jobs queue and the worker are working.',
  cron: '*/5 * * * *',
  timezone: 'Asia/Kolkata',
  queue: SYSTEM_JOBS_QUEUE,
  message: heartbeatTick,
  data: {},
});
