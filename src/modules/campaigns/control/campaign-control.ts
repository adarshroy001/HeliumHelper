import { z } from 'zod';
import { defineMessage } from '../../../infrastructure/queue/index.js';

/**
 * Heavy campaign work: building the audience (and, with M12, starting and stopping). Each command re-checks the
 * campaign's status, so order and duplicates don't matter; quick changes (pause, resume) are made by the API.
 */
export const CAMPAIGN_CONTROL_QUEUE = 'campaign-control';

/** A command for one campaign. One message type, naming the command: a queue has one consumer. */
export const campaignCommand = defineMessage(
  'campaign.command.run',
  z.strictObject({
    campaignId: z.string().regex(/^[a-f\d]{24}$/),
    command: z.enum(['build']),
  }),
);
export type CampaignCommand = z.infer<typeof campaignCommand.schema>;
