import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Redis } from 'ioredis';
import { whatsappConfig, type WhatsappConfig } from '../../config/index.js';
import { AccountsRepository } from './data/messaging.repositories.js';
import { keys } from './messaging.keys.js';

/** The account ID of the one WhatsApp number we send from today. */
export const MAIN_ACCOUNT_ID = 'main';

/**
 * The WhatsApp account: kept in step with config at start (created, or its IDs and rate refreshed), and paused
 * or resumed as a whole when Meta says it can't send (token, ban, restriction).
 */
@Injectable()
export class AccountsService implements OnApplicationBootstrap {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly accounts: AccountsRepository,
    private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.accounts.upsertFromConfig({ _id: MAIN_ACCOUNT_ID, ...this.config.account });
  }

  /** What a campaign start checks: the account's state and whether marketing is paused on it. */
  async health(): Promise<{
    paused: boolean;
    pauseReason?: string;
    marketingPaused: boolean;
    quality?: string;
  }> {
    const [account, marketing] = await Promise.all([
      this.accounts.findById(MAIN_ACCOUNT_ID),
      this.redis.get(keys.marketingPaused(MAIN_ACCOUNT_ID)),
    ]);
    return {
      paused: account?.status === 'paused',
      ...(account?.pauseReason === undefined ? {} : { pauseReason: account.pauseReason }),
      marketingPaused: marketing !== null,
      ...(account?.quality === undefined ? {} : { quality: account.quality }),
    };
  }

  /** Stops all sending from the account: the senders' gate closes within a receive. */
  async pause(reason: string): Promise<void> {
    await this.redis.set(keys.accountPaused(MAIN_ACCOUNT_ID), reason);
    await this.accounts.setStatus(MAIN_ACCOUNT_ID, 'paused', reason);
  }

  async resume(): Promise<void> {
    await this.redis.del(keys.accountPaused(MAIN_ACCOUNT_ID));
    await this.accounts.setStatus(MAIN_ACCOUNT_ID, 'active');
  }
}
