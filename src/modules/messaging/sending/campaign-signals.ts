import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { luaScript, runScript } from '../../../infrastructure/redis/index.js';
import { keys } from '../messaging.keys.js';

/**
 * Pauses a campaign that is sending, recording why: KEYS state, pause request; ARGV reason. Returns 1 if it was
 * paused now. A paused or stopped campaign is left as it is.
 */
const pauseIfSending = luaScript<number>({
  name: 'pauseIfSending',
  keys: 2,
  lua: `
if redis.call('GET', KEYS[1]) ~= 'sending' then return 0 end
redis.call('SET', KEYS[1], 'paused')
redis.call('SET', KEYS[2], ARGV[1])
return 1
`,
});

/**
 * How the messaging module tells campaigns to stop sending without depending on the campaigns module: it pauses
 * the campaign's Redis state (the sender and feeder obey it within a second) and leaves a reason, which the
 * campaign sweeper records on the campaign. The campaign lifecycle registers which campaigns use which template.
 */
@Injectable()
export class CampaignSignals {
  constructor(private readonly redis: Redis) {}

  async pause(campaignId: string, reason: string): Promise<boolean> {
    const paused = await runScript(
      this.redis,
      pauseIfSending,
      [keys.campaignState(campaignId), keys.campaignPauseRequest(campaignId)],
      [reason],
    );
    return paused === 1;
  }

  /** Pauses every sending campaign that uses a template; returns the ones paused. */
  async pauseTemplateUsers(template: { name: string; language: string }, reason: string): Promise<string[]> {
    const campaigns = await this.redis.smembers(keys.templateCampaigns(template.name, template.language));
    const paused: string[] = [];
    for (const campaignId of campaigns) if (await this.pause(campaignId, reason)) paused.push(campaignId);
    return paused;
  }
}
