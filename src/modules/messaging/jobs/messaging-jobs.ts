import { z } from 'zod';
import { defineMessage, defineSchedule } from '../../../infrastructure/queue/index.js';

/** The messaging module's housekeeping queue. */
export const MESSAGING_JOBS_QUEUE = 'messaging-jobs';

/** One housekeeping job; a queue has one consumer, so the jobs share a message type and name the job. */
export const messagingJob = defineMessage(
  'messaging.job.run',
  z.strictObject({ job: z.enum(['templates-sync', 'suppressions-reload', 'unconfirmed-settle']) }),
);
export type MessagingJobData = z.infer<typeof messagingJob.schema>;

export const templatesSyncSchedule = defineSchedule({
  name: 'messaging-templates-sync',
  description: "Mirrors Meta's templates and the number's quality into the messaging database.",
  cron: '*/15 * * * *',
  timezone: 'Asia/Kolkata',
  queue: MESSAGING_JOBS_QUEUE,
  message: messagingJob,
  data: { job: 'templates-sync' },
});

export const suppressionsReloadSchedule = defineSchedule({
  name: 'messaging-suppressions-reload',
  description: 'Reloads the Redis mirror of the suppression list from the database.',
  cron: '*/10 * * * *',
  timezone: 'Asia/Kolkata',
  queue: MESSAGING_JOBS_QUEUE,
  message: messagingJob,
  data: { job: 'suppressions-reload' },
});

export const unconfirmedSettleSchedule = defineSchedule({
  name: 'messaging-unconfirmed-settle',
  description: 'Settles sends whose result was unknown for 15 minutes: resolved, sent once more, or failed.',
  cron: '* * * * *',
  timezone: 'Asia/Kolkata',
  queue: MESSAGING_JOBS_QUEUE,
  message: messagingJob,
  data: { job: 'unconfirmed-settle' },
});
