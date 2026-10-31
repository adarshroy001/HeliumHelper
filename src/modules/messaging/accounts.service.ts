import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { whatsappConfig, type WhatsappConfig } from '../../config/index.js';
import { AccountsRepository } from './data/messaging.repositories.js';

/** The account ID of the one WhatsApp number we send from today. */
export const MAIN_ACCOUNT_ID = 'main';

/** Keeps `wa_accounts` in step with config: the account is created, or its IDs and rate refreshed, at start. */
@Injectable()
export class AccountsService implements OnApplicationBootstrap {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly accounts: AccountsRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.accounts.upsertFromConfig({ _id: MAIN_ACCOUNT_ID, ...this.config.account });
  }
}
