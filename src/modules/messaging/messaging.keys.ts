import { redisKey } from '../../infrastructure/redis/index.js';

/**
 * The messaging module's Redis keys (docs/modules/messaging/data-model.md#redis-keys). Keys a script uses together
 * share a hash tag: the phone number ID for rate limits, the campaign ID for counters.
 */
export const keys = {
  /** Kill switch: when set, no message is sent. */
  killSwitch: () => redisKey('cfg', 'wa-pause', 'global'),
  /** An account paused by a fatal error (token, ban) or by an operator. */
  accountPaused: (accountId: string) => redisKey('wa', 'acct-paused', accountId),
  bucket: (phoneNumberId: string) => redisKey('wa', 'rl', phoneNumberId),
  rate: (phoneNumberId: string) => redisKey('wa', 'rate', phoneNumberId),
  numberPause: (phoneNumberId: string) => redisKey('wa', 'pause', phoneNumberId),
  /** `sending`, `paused` or `stopped`, set by the campaign lifecycle. */
  campaignState: (campaignId: string) => redisKey('wa', 'camp', campaignId),
  /** Why the sender paused a campaign (a template error); the campaign sweeper records it. */
  campaignPauseRequest: (campaignId: string) => redisKey('wa', 'camp-pause', campaignId),
  ranks: (campaignId: string) => redisKey('wa', 'st', campaignId),
  counters: (campaignId: string) => redisKey('wa', 'cnt', campaignId),
  claim: (deliveryId: string) => redisKey('wa', 'claim', deliveryId),
  wamid: (wamid: string) => redisKey('wa', 'wamid', wamid),
  unconfirmed: () => redisKey('wa', 'unconfirmed', 'global'),
  uniqueUsers: (portfolioId: string, hour: string) => redisKey('wa', 'uniq', `${portfolioId}:${hour}`),
  suppressed: () => redisKey('wa', 'supp', 'global'),
  /** Open while a customer's last message is under 24 h old: free-form replies are allowed. */
  serviceWindow: (phone: string) => redisKey('wa', 'csw', phone),
  /** The first button each recipient tapped (deliveryId → button), so a poll counts one vote per person. */
  votes: (campaignId: string) => redisKey('wa', 'vote', campaignId),
  /** Campaigns sending with a template (`name:language`), registered by the campaign lifecycle. */
  templateCampaigns: (name: string, language: string) => redisKey('wa', 'tpl-camps', `${name}:${language}`),
  /** Marketing stopped on an account (phone quality flagged); direct sends and replies continue. */
  marketingPaused: (accountId: string) => redisKey('wa', 'mkt-paused', accountId),
  /** The business portfolio's daily messaging limit (unique users), from Meta's capability events. */
  messagingLimit: (portfolioId: string) => redisKey('wa', 'limit', portfolioId),
  /** Recipients of a campaign who opted out by replying to it (deliveryId → 1), counted once each. */
  optOuts: (campaignId: string) => redisKey('wa', 'optout', campaignId),
  /** Poll results: button → votes. */
  buttons: (campaignId: string) => redisKey('wa', 'btn', campaignId),
  /** A campaign's auto-reply rule (JSON), published by the campaign lifecycle while it runs. */
  autoReply: (campaignId: string) => redisKey('wa', 'autoreply', campaignId),
} as const;
