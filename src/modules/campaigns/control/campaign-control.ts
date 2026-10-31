import { z } from 'zod';
import { defineMessage, defineSchedule } from '../../../infrastructure/queue/index.js';

/**
 * Heavy campaign work: building the audience, activating a start, test sends, and the sweeper. Each command
 * re-checks the campaign's status, so order and duplicates don't matter; quick changes (pause, stop) are made by
 * the API.
 */
export const CAMPAIGN_CONTROL_QUEUE = 'campaign-control';

const id = z.string().regex(/^[a-f\d]{24}$/);

/** A command. One message type, naming the command: a queue has one consumer. */
export const campaignCommand = defineMessage(
  'campaign.command.run',
  z.discriminatedUnion('command', [
    z.strictObject({ command: z.literal('build'), campaignId: id }),
    z.strictObject({ command: z.literal('start'), campaignId: id }),
    z.strictObject({ command: z.literal('test'), campaignId: id, phones: z.array(z.string()).min(1).max(5) }),
    z.strictObject({ command: z.literal('sweep') }),
  ]),
);
export type CampaignCommand = z.infer<typeof campaignCommand.schema>;

/** Every minute: due schedules, pauses asked for by the messaging module, completion, closing, stuck builds. */
export const campaignSweepSchedule = defineSchedule({
  name: 'campaign-sweep',
  description: 'Starts due campaigns, records automatic pauses, completes, closes and recovers campaigns.',
  cron: '* * * * *',
  timezone: 'Asia/Kolkata',
  queue: CAMPAIGN_CONTROL_QUEUE,
  message: campaignCommand,
  data: { command: 'sweep' },
});
