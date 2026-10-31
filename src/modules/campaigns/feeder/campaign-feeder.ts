import { randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { type BackgroundLoop, QueuePublisher, WorkerLoop } from '../../../infrastructure/queue/index.js';
import { luaScript, runScript } from '../../../infrastructure/redis/index.js';
import {
  CampaignCounters,
  DeliveryLedger,
  deliverySend,
  MAIN_ACCOUNT_ID,
  messagingKeys,
  WA_SEND_P2_QUEUE,
} from '../../messaging/index.js';
import type { CampaignDocument } from '../campaign.schema.js';
import { CampaignsRepository } from '../campaigns.repository.js';
import { inFlight } from '../lifecycle/campaign-sweeper.service.js';
import { holdReason } from './feed-rules.js';

const TICK_MS = 1_000;
const LOCK_MS = 15_000;
/** Seconds of sending the feeder keeps queued per number. */
const BACKLOG_SECONDS = 120;
const MAX_BATCH = 1_000;

/** Renews the leader lock only while it is still ours. KEYS lock; ARGV owner, ttl. */
const renewIfOwner = luaScript<number>({
  name: 'renewIfOwner',
  keys: 1,
  lua: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`,
});

/** Gives the lock up only while it is still ours. KEYS lock; ARGV owner. */
const releaseIfOwner = luaScript<number>({
  name: 'releaseFeederLock',
  keys: 1,
  lua: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
});

/**
 * Moves pending deliveries into `wa-send-p2` at the allowed pace (design.md#feeder). One leader across all workers
 * (a Redis lock renewed every second; another worker takes over within 15 s). Every second, for each active
 * campaign: hold it back if it's outside its send window, marketing is paused or the daily limit is near;
 * otherwise top its queue up to two minutes of sending, shared fairly between the campaigns on the number, and
 * never faster than its speed cap.
 */
@WorkerLoop('campaign-feeder')
export class CampaignFeeder implements BackgroundLoop {
  private readonly owner = randomUUID();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private leader = false;

  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly campaigns: CampaignsRepository,
    private readonly ledger: DeliveryLedger,
    private readonly counters: CampaignCounters,
    private readonly publisher: QueuePublisher,
    private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(CampaignFeeder.name);
  }

  start(): void {
    this.timer = setInterval(() => {
      this.running ??= this.tick()
        .catch((err: unknown) => {
          this.logger.warn({ err }, 'feeder pass failed');
        })
        .finally(() => {
          this.running = undefined;
        });
    }, TICK_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
    if (this.leader) await runScript(this.redis, releaseIfOwner, [messagingKeys.feederLock()], [this.owner]);
  }

  /** One pass: keep (or win) the lead, then feed every active campaign. Exposed for tests. */
  async tick(): Promise<void> {
    if (!(await this.lead())) return;
    const ids = await this.redis.smembers(messagingKeys.activeCampaigns());
    if (ids.length === 0) return;
    const campaigns = (await this.campaigns.findByIds(ids)).filter(
      (c) => c.status === 'sending' && c.send !== undefined,
    );
    const states =
      campaigns.length === 0
        ? []
        : await this.redis.mget(campaigns.map((c) => messagingKeys.campaignState(String(c._id))));
    const sending = campaigns.filter((_, i) => states[i] === 'sending');
    for (const campaign of sending) await this.feed(campaign, sending.length);
  }

  private async lead(): Promise<boolean> {
    const lock = messagingKeys.feederLock();
    if (this.leader) {
      this.leader = (await runScript(this.redis, renewIfOwner, [lock], [this.owner, LOCK_MS])) === 1;
    } else {
      this.leader = (await this.redis.set(lock, this.owner, 'PX', LOCK_MS, 'NX')) === 'OK';
      if (this.leader) this.logger.info('feeder leading');
    }
    return this.leader;
  }

  private async feed(campaign: CampaignDocument, sharing: number): Promise<void> {
    const id = String(campaign._id);
    const send = campaign.send;
    if (send === undefined) return;
    const reason = await holdReason(campaign, new Date(), this.redis, this.config.account.portfolioId);
    if (reason !== null) {
      await this.redis.set(messagingKeys.campaignWaiting(id), reason, 'EX', 120);
      return;
    }
    await this.redis.del(messagingKeys.campaignWaiting(id));

    const rate = Number(
      (await this.redis.hget(messagingKeys.rate(send.phoneNumberId), 'rate')) ?? this.config.account.maxMps,
    );
    const target = Math.ceil((Math.min(rate, this.config.account.maxMps) * BACKLOG_SECONDS) / sharing);
    const cap = campaign.options.maxMps;
    const want = Math.min(target - inFlight(await this.counters.read(id)), cap ?? MAX_BATCH, MAX_BATCH);
    if (want <= 0) return;

    const cursor = Number((await this.redis.hget(messagingKeys.feedCursor(id), 'cursor')) ?? -1);
    const rows = await this.ledger.pendingAfter(id, cursor, want);
    if (rows.length === 0) {
      await this.redis.hset(messagingKeys.feedCursor(id), 'exhausted', '1');
      return;
    }
    const header = send.template.components ?? [];
    // Counted as fed before publishing: if publishing fails, the count is taken back.
    await this.counters.increment(id, 'fed', rows.length);
    try {
      await this.publisher.publishBatch(
        WA_SEND_P2_QUEUE,
        deliverySend,
        rows.map((row) => ({
          data: {
            deliveryId: row.id,
            accountId: MAIN_ACCOUNT_ID,
            phoneNumberId: send.phoneNumberId,
            to: row.to,
            endpoint: send.endpoint,
            campaignId: id,
            payload:
              row.payload.kind === 'template'
                ? {
                    kind: 'template',
                    template: {
                      ...row.payload.template,
                      components: [...header, ...(row.payload.template.components ?? [])],
                    },
                  }
                : row.payload,
            businessInitiated: true,
          },
          groupId: id,
        })),
      );
    } catch (error) {
      await this.counters.increment(id, 'fed', -rows.length);
      throw error;
    }
    await this.redis
      .multi()
      .hset(messagingKeys.feedCursor(id), 'cursor', String(rows.at(-1)?.seq ?? cursor))
      .hdel(messagingKeys.feedCursor(id), 'exhausted')
      .exec();
  }
}
