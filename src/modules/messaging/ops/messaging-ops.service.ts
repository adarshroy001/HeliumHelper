import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Actor } from '../../../common/auth/index.js';
import { queueConfig, type QueueConfig, whatsappConfig, type WhatsappConfig } from '../../../config/index.js';
import { AuditService } from '../../audit/index.js';
import { AccountsService, MAIN_ACCOUNT_ID } from '../accounts.service.js';
import { QueueNotKnownError } from '../messaging.errors.js';
import { keys } from '../messaging.keys.js';

/** The queues operators look after (docs/modules/messaging/data-model.md#queues). */
export const OPERATED_QUEUES = [
  'wa-send-p1',
  'wa-send-p2',
  'wa-status',
  'wa-inbound',
  'wa-account',
  'messaging-jobs',
  'campaign-control',
] as const;
export type OperatedQueue = (typeof OPERATED_QUEUES)[number];

/** Messages moved back from a DLQ per redrive call, so one call stays short. */
const REDRIVE_LIMIT = 1000;

/**
 * What operators need without a deploy (docs/RUNBOOK.md#messaging): queue and DLQ depths, the kill switch, the
 * account's and the number's state, DLQ redrive and resuming a paused account. Every change is audited.
 */
@Injectable()
export class MessagingOpsService {
  constructor(
    @Inject(queueConfig.KEY) private readonly queues: QueueConfig,
    @Inject(whatsappConfig.KEY) private readonly config: WhatsappConfig,
    private readonly sqs: SQSClient,
    private readonly redis: Redis,
    private readonly accounts: AccountsService,
    private readonly audit: AuditService,
  ) {}

  async status() {
    const pn = this.config.account.phoneNumberId;
    const [kill, accountPause, marketingPause, numberPauseMs, rate, unconfirmed, active, health] =
      await Promise.all([
        this.redis.get(keys.killSwitch()),
        this.redis.get(keys.accountPaused(MAIN_ACCOUNT_ID)),
        this.redis.get(keys.marketingPaused(MAIN_ACCOUNT_ID)),
        this.redis.pttl(keys.numberPause(pn)),
        this.redis.hget(keys.rate(pn), 'rate'),
        this.redis.zcard(keys.unconfirmed()),
        this.redis.scard(keys.activeCampaigns()),
        this.accounts.health(),
      ]);
    return {
      killSwitch: kill !== null,
      account: {
        id: MAIN_ACCOUNT_ID,
        ...health,
        pausedInRedis: accountPause !== null,
        marketingPaused: marketingPause !== null,
      },
      number: {
        phoneNumberId: pn,
        maxMps: this.config.account.maxMps,
        currentMps: rate === null ? this.config.account.maxMps : Math.floor(Number(rate)),
        pausedForMs: numberPauseMs > 0 ? numberPauseMs : 0,
      },
      unconfirmedSends: unconfirmed,
      activeCampaigns: active,
      queues: await Promise.all(
        OPERATED_QUEUES.map(async (name) => ({
          name,
          ...(await this.depth(name)),
          dlq: await this.depth(`${name}-dlq`),
        })),
      ),
    };
  }

  /** Stops (or allows) all sending within a second: the senders' gate reads this key before every receive. */
  async setKillSwitch(on: boolean, actor: Actor): Promise<void> {
    if (on) await this.redis.set(keys.killSwitch(), actor.user?.email ?? actor.service);
    else await this.redis.del(keys.killSwitch());
    await this.audit.record({
      actor,
      action: on ? 'messaging.stop_all' : 'messaging.allow_all',
      entity: { type: 'messaging', id: 'kill-switch' },
    });
  }

  /** Moves up to 1,000 messages from a queue's DLQ back to the queue; returns how many. */
  async redrive(queue: string, actor: Actor): Promise<{ moved: number }> {
    if (!(OPERATED_QUEUES as readonly string[]).includes(queue)) throw new QueueNotKnownError(queue);
    const source = `${this.queues.queueUrlPrefix}${queue}-dlq`;
    const target = `${this.queues.queueUrlPrefix}${queue}`;
    let moved = 0;
    while (moved < REDRIVE_LIMIT) {
      const { Messages = [] } = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: source,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
          VisibilityTimeout: 60,
        }),
      );
      if (Messages.length === 0) break;
      const entries = Messages.map((m, i) => ({ Id: String(i), MessageBody: m.Body ?? '' }));
      const sent = await this.sqs.send(new SendMessageBatchCommand({ QueueUrl: target, Entries: entries }));
      const ok = new Set((sent.Successful ?? []).map((s) => s.Id));
      const done = Messages.filter((_, i) => ok.has(String(i)));
      if (done.length > 0) {
        await this.sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: source,
            Entries: done.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle ?? '' })),
          }),
        );
      }
      moved += done.length;
      if (done.length < Messages.length) break;
    }
    await this.audit.record({
      actor,
      action: 'messaging.redrive',
      entity: { type: 'queue', id: queue },
      after: { moved },
    });
    return { moved };
  }

  async resumeAccount(actor: Actor): Promise<void> {
    await this.accounts.resume();
    await this.audit.record({
      actor,
      action: 'account.resume',
      entity: { type: 'account', id: MAIN_ACCOUNT_ID },
    });
  }

  private async depth(name: string): Promise<{ visible: number; inFlight: number; delayed: number }> {
    try {
      const { Attributes = {} } = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: `${this.queues.queueUrlPrefix}${name}`,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed',
          ],
        }),
      );
      return {
        visible: Number(Attributes.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
        delayed: Number(Attributes.ApproximateNumberOfMessagesDelayed ?? 0),
      };
    } catch {
      return { visible: -1, inFlight: -1, delayed: -1 };
    }
  }
}
