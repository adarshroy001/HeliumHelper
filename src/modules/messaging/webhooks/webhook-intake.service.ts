import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { QueuePublisher } from '../../../infrastructure/queue/index.js';
import {
  WebhookNotQueuedError,
  WebhookSignatureInvalidError,
  WebhookVerificationFailedError,
} from '../messaging.errors.js';
import {
  WA_ACCOUNT_QUEUE,
  WA_INBOUND_QUEUE,
  WA_STATUS_QUEUE,
  webhookAccount,
  webhookInbound,
  webhookStatus,
} from '../messaging.messages.js';
import {
  isValidSignature,
  splitWebhook,
  type WebhookChange,
  type WebhookRoute,
} from '../whatsapp/webhook.js';

const ROUTES = {
  status: { queue: WA_STATUS_QUEUE, message: webhookStatus },
  inbound: { queue: WA_INBOUND_QUEUE, message: webhookInbound },
  account: { queue: WA_ACCOUNT_QUEUE, message: webhookAccount },
} as const;

/**
 * Accepts Meta's webhooks: verify, split, queue (docs/modules/messaging/design.md#webhooks). Touches no database
 * and no Redis, so it stays fast and available whatever the workers are doing.
 */
@Injectable()
export class WebhookIntakeService {
  constructor(
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly publisher: QueuePublisher,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(WebhookIntakeService.name);
  }

  /** Meta's subscription check: returns the challenge to echo. */
  verify(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    if (mode !== 'subscribe' || token !== this.config.verifyToken || challenge === undefined) {
      throw new WebhookVerificationFailedError();
    }
    return challenge;
  }

  /** Verifies and queues one webhook. Throws when it must be retried by Meta. */
  async accept(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    if (rawBody === undefined || !isValidSignature(rawBody, signature, this.config.appSecrets)) {
      this.logger.warn('webhook signature invalid');
      throw new WebhookSignatureInvalidError();
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      body = undefined;
    }
    const split = splitWebhook(body, new Date());
    if (!split.ok) {
      // Signed by Meta but not something we can process: retrying won't help, so accept it.
      this.logger.warn({ problem: split.problem }, 'webhook ignored');
      return;
    }

    const byRoute = new Map<WebhookRoute, WebhookChange[]>();
    for (const { route, change } of split.changes) {
      byRoute.set(route, [...(byRoute.get(route) ?? []), change]);
      if (route === 'account') this.logger.info({ field: change.field }, 'account webhook');
    }
    try {
      await Promise.all(
        [...byRoute].map(([route, changes]) =>
          this.publisher.publishBatch(
            ROUTES[route].queue,
            ROUTES[route].message,
            changes.map((data) => ({ data })),
          ),
        ),
      );
    } catch (error) {
      throw new WebhookNotQueuedError(error);
    }
  }
}
