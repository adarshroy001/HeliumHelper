import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { QueuePublisher } from '../../../infrastructure/queue/index.js';
import { luaScript, runScript } from '../../../infrastructure/redis/index.js';
import { MAIN_ACCOUNT_ID } from '../accounts.service.js';
import { DeliveriesRepository } from '../data/deliveries.repository.js';
import { STATUS_RANK } from '../data/delivery.schema.js';
import { keys } from '../messaging.keys.js';
import { deliverySend, WA_SEND_P1_QUEUE } from '../messaging.messages.js';
import { CampaignCounters } from './campaign-counters.js';

/** A send with no result for this long, and no status from Meta, is settled. */
const UNCONFIRMED_AFTER_MS = 15 * 60 * 1000;
const BATCH = 500;

/** Moves a campaign's feed cursor back to just before `seq`, if it is past it. KEYS feed; ARGV seq. */
const rewindFeed = luaScript<number>({
  name: 'rewindFeed',
  keys: 1,
  lua: `
local cursor = tonumber(redis.call('HGET', KEYS[1], 'cursor') or '-1')
local target = tonumber(ARGV[1]) - 1
if cursor > target then redis.call('HSET', KEYS[1], 'cursor', target) end
redis.call('HDEL', KEYS[1], 'exhausted')
return target
`,
});

/**
 * Settles sends whose result is unknown (design.md#unknown-results): a timeout after the request was written, or a
 * sender that died mid-call. If Meta has since reported a status, or the result was recorded, it's resolved.
 * Otherwise the delivery is sent once more; a second unknown result fails it with `unconfirmed`.
 */
@Injectable()
export class UnconfirmedSettler {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly redis: Redis,
    private readonly deliveries: DeliveriesRepository,
    private readonly counters: CampaignCounters,
    private readonly publisher: QueuePublisher,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(UnconfirmedSettler.name);
  }

  /** Settles what has been in doubt for 15 minutes; returns how many were settled. */
  async settle(now = Date.now()): Promise<number> {
    const ids = await this.redis.zrangebyscore(
      keys.unconfirmed(),
      '-inf',
      now - UNCONFIRMED_AFTER_MS,
      'LIMIT',
      0,
      BATCH,
    );
    for (const id of ids) {
      const [claim, delivery] = await Promise.all([
        this.redis.get(keys.claim(id)),
        this.deliveries.findById(id),
      ]);
      if (
        delivery === null ||
        claim?.startsWith('ok:') === true ||
        delivery.statusRank >= STATUS_RANK.accepted
      ) {
        await this.redis.zrem(keys.unconfirmed(), id);
        continue;
      }
      const campaignId = delivery.campaignId === undefined ? undefined : String(delivery.campaignId);
      if (delivery.unconfirmedRetry === true) {
        const at = new Date();
        await this.deliveries.applySendOutcomes([
          { id, result: 'failed', error: { title: 'unconfirmed', at }, at },
        ]);
        if (campaignId !== undefined)
          await this.counters.apply([{ campaignId, deliveryId: id, status: 'failed' }]);
        this.logger.warn({ deliveryId: id, campaignId }, 'send failed: result unknown twice');
      } else {
        await this.redis.del(keys.claim(id));
        await this.deliveries.markUnconfirmedRetry(id);
        if (campaignId !== undefined && delivery.seq !== undefined) {
          // Fed again by the feeder: rewind its cursor, and take the first feed back off the count.
          await runScript(this.redis, rewindFeed, [keys.feedCursor(campaignId)], [delivery.seq]);
          await this.counters.increment(campaignId, 'fed', -1);
        } else {
          await this.publisher.publish(WA_SEND_P1_QUEUE, deliverySend, {
            deliveryId: id,
            accountId: MAIN_ACCOUNT_ID,
            phoneNumberId: this.config.account.phoneNumberId,
            to: delivery.to,
            endpoint: 'messages',
            payload: delivery.payload,
            businessInitiated: delivery.source.kind !== 'auto_reply',
            unconfirmedRetry: true,
          });
        }
        this.logger.info({ deliveryId: id, campaignId }, 'unconfirmed send queued again');
      }
      await this.redis.zrem(keys.unconfirmed(), id);
    }
    return ids.length;
  }
}
