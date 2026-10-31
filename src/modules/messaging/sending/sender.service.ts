import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { maskPhone } from '../../../common/utils/mask-phone.js';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { ack, hold, retry, type Outcome } from '../../../infrastructure/queue/index.js';
import { AccountsService, MAIN_ACCOUNT_ID } from '../accounts.service.js';
import type { SendOutcome } from '../data/deliveries.repository.js';
import { keys } from '../messaging.keys.js';
import type { DeliverySendData } from '../messaging.messages.js';
import { GraphClient, type SendResult } from '../whatsapp/graph-client.js';
import {
  META_NUMBER_UPGRADING,
  META_PAIR_LIMITED,
  META_THROUGHPUT_LIMITED,
  retryDelaySeconds,
} from '../whatsapp/meta-errors.js';
import { deliveryRef } from '../statuses/delivery-ref.js';
import { CampaignCounters } from './campaign-counters.js';
import { CampaignSignals } from './campaign-signals.js';
import { type Priority, RateLimiter } from './rate-limiter.js';
import { SendFlusher } from './send-flusher.js';

/** A claim outlives any retry or re-feed of its delivery (ADR-0015). */
const CLAIM_SECONDS = 3 * 24 * 60 * 60;
/** Retryable failures before a delivery is marked failed instead of retried again. */
const MAX_ATTEMPTS = 5;
/** How long a campaign's state is cached per process: pause and stop take effect within this. */
const STATE_CACHE_MS = 1_000;

/**
 * Sends one message (design.md#sender-loop): campaign state, suppression, a rate-limit token, a claim so it can
 * never be sent twice, the call to Meta, then the result, written in a batch before the message is deleted.
 */
@Injectable()
export class SenderService {
  private readonly states = new Map<string, { state: string | null; at: number }>();
  private replicas: Promise<number> | undefined;

  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly redis: Redis,
    private readonly graph: GraphClient,
    private readonly limiter: RateLimiter,
    private readonly flusher: SendFlusher,
    private readonly accountsService: AccountsService,
    private readonly signals: CampaignSignals,
    private readonly counters: CampaignCounters,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(SenderService.name);
  }

  /**
   * The gate before each receive: nothing is taken off the queue while sending is switched off, the account is
   * paused, or (for campaign sends) marketing is paused on the account.
   */
  async canSend(priority: Priority): Promise<boolean> {
    const [kill, paused, marketing] = await this.redis.mget(
      keys.killSwitch(),
      keys.accountPaused(MAIN_ACCOUNT_ID),
      keys.marketingPaused(MAIN_ACCOUNT_ID),
    );
    return kill === null && paused === null && (priority === 1 || marketing === null);
  }

  async send(data: DeliverySendData, priority: Priority, receiveCount: number): Promise<Outcome> {
    const { deliveryId: id, campaignId } = data;
    const held = await this.campaignHold(id, campaignId);
    if (held !== null) return held;
    if (data.businessInitiated && (await this.redis.sismember(keys.suppressed(), data.to)) === 1) {
      return this.record({ id, result: 'skipped', reason: 'suppressed', at: new Date() }, campaignId);
    }

    await this.limiter.acquire(data.phoneNumberId, priority, this.config.account.maxMps);
    // Waiting for a token can take seconds: a pause or stop in the meantime still applies.
    const heldAfterWait = await this.campaignHold(id, campaignId);
    if (heldAfterWait !== null) return heldAfterWait;

    const claimKey = keys.claim(id);
    if ((await this.redis.set(claimKey, 'inflight', 'EX', CLAIM_SECONDS, 'NX')) === null) {
      // Claimed before: sent already (record it again, harmlessly) or still in doubt (the sweeper settles it).
      const claim = await this.redis.get(claimKey);
      if (claim?.startsWith('ok:') === true) {
        return this.record({ id, result: 'accepted', wamid: claim.slice(3), at: new Date() }, campaignId);
      }
      return ack();
    }
    if ((await this.replicaCount()) > 0) await this.redis.wait(1, 100);
    // In doubt until the result is known: if this process dies mid-call, the sweeper finds it here.
    await this.redis.zadd(keys.unconfirmed(), Date.now(), id);

    const result = await this.graph.send({
      phoneNumberId: data.phoneNumberId,
      endpoint: data.endpoint,
      to: data.to,
      content: data.payload,
      callbackData: deliveryRef(id, campaignId),
    });
    return this.settle(data, result, priority, receiveCount);
  }

  private async settle(
    data: DeliverySendData,
    result: SendResult,
    priority: Priority,
    receiveCount: number,
  ): Promise<Outcome> {
    const { deliveryId: id, campaignId } = data;
    const at = new Date();
    if (result.ok) {
      const pipeline = this.redis
        .multi()
        .set(keys.claim(id), `ok:${result.wamid}`, 'EX', CLAIM_SECONDS)
        .set(keys.wamid(result.wamid), deliveryRef(id, campaignId).slice(2), 'EX', CLAIM_SECONDS)
        .zrem(keys.unconfirmed(), id);
      if (data.businessInitiated) {
        const hour = keys.uniqueUsers(
          this.config.account.portfolioId,
          at.toISOString().slice(0, 13).replace(/\D/g, ''),
        );
        pipeline.pfadd(hour, data.to).expire(hour, 26 * 60 * 60);
      }
      await pipeline.exec();
      return this.record({ id, result: 'accepted', wamid: result.wamid, at }, campaignId);
    }

    const log = {
      deliveryId: id,
      campaignId,
      to: maskPhone(data.to),
      class: result.class,
      code: result.code,
      detail: result.detail,
    };
    if (result.class === 'ambiguous') {
      // Maybe sent: keep the claim so it is never sent twice; the status webhook or the sweeper settles it.
      this.logger.warn(log, 'send result unknown');
      return ack();
    }

    // Certainly not sent: release the claim.
    await this.redis.multi().del(keys.claim(id)).zrem(keys.unconfirmed(), id).exec();
    const failed = (title: string) =>
      this.record(
        {
          id,
          result: 'failed',
          error: { ...(result.code === undefined ? {} : { code: result.code }), title, at },
          at,
        },
        campaignId,
      );

    switch (result.class) {
      case 'permanent':
        return failed(result.detail);
      case 'rate_limited':
        if (result.code === META_PAIR_LIMITED) return hold(10);
        await this.limiter.rateLimited(
          data.phoneNumberId,
          result.code === META_NUMBER_UPGRADING ? 'upgrading' : 'throughput',
          this.config.account.maxMps,
        );
        this.logger.info(log, 'rate limited by Meta');
        return hold(result.code === META_THROUGHPUT_LIMITED ? 2 : 60);
      case 'retryable':
        if (result.unknownCode === true)
          this.logger.warn({ ...log, unknownCode: true }, 'unknown Meta error code');
        if (receiveCount >= MAX_ATTEMPTS)
          return failed(`gave up after ${String(MAX_ATTEMPTS)} attempts: ${result.detail}`);
        return retry(retryDelaySeconds(receiveCount));
      case 'fatal':
        this.logger.error(log, 'fatal Meta error');
        if (result.fatalScope === 'account') {
          await this.accountsService.pause(result.detail);
          return hold(900);
        }
        if (campaignId === undefined || priority === 1) return failed(result.detail);
        await this.pauseCampaign(campaignId, `${String(result.code)}: ${result.detail}`);
        // It stays pending and is fed again when the campaign resumes.
        return ack();
    }
  }

  /**
   * What to do instead of sending when the campaign isn't sending: a stopped campaign's delivery is skipped; a
   * paused (or not started) one stays pending and is fed again on resume, so it no longer counts as fed.
   */
  private async campaignHold(id: string, campaignId: string | undefined): Promise<Outcome | null> {
    if (campaignId === undefined) return null;
    const state = await this.campaignState(campaignId);
    if (state === 'sending') return null;
    if (state === 'stopped')
      return this.record({ id, result: 'skipped', reason: 'stopped', at: new Date() }, campaignId);
    await this.counters.increment(campaignId, 'fed', -1);
    return ack();
  }

  private async record(outcome: SendOutcome, campaignId: string | undefined): Promise<Outcome> {
    await this.flusher.record(outcome, campaignId);
    return ack();
  }

  private async campaignState(campaignId: string): Promise<string | null> {
    const cached = this.states.get(campaignId);
    if (cached !== undefined && Date.now() - cached.at < STATE_CACHE_MS) return cached.state;
    const state = await this.redis.get(keys.campaignState(campaignId));
    this.states.set(campaignId, { state, at: Date.now() });
    return state;
  }

  /** The campaign sweeper turns the pause request into a paused campaign with this reason. */
  private async pauseCampaign(campaignId: string, reason: string): Promise<void> {
    await this.signals.pause(campaignId, reason);
    this.states.delete(campaignId);
  }

  /** Replicas of the Redis primary; `WAIT` for one only when there is one (ElastiCache, not locally). */
  private replicaCount(): Promise<number> {
    this.replicas ??= this.redis
      .info('replication')
      .then((info) => Number(/connected_slaves:(\d+)/.exec(info)?.[1] ?? 0))
      .catch(() => 0);
    return this.replicas;
  }
}
