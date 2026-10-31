import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DeliveriesRepository, type SendOutcome } from '../data/deliveries.repository.js';
import { CampaignCounters, type CounterEvent } from './campaign-counters.js';

/** Results written per round trip, and the longest a result waits for its batch. */
const MAX_BATCH = 500;
const MAX_WAIT_MS = 200;

interface Pending {
  readonly outcome: SendOutcome;
  readonly campaignId: string | undefined;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * Batches the sender's results (design.md#sender-loop): every 200 ms or 500 results, ONE `bulkWrite` to
 * `deliveries`, then the campaign counters. Each sender call waits for its batch before its message is deleted,
 * so the database is written before SQS forgets the work.
 */
@Injectable()
export class SendFlusher implements OnModuleDestroy {
  private pending: Pending[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deliveries: DeliveriesRepository,
    private readonly counters: CampaignCounters,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(SendFlusher.name);
  }

  /** Resolves once the outcome is written; rejects if the database write failed (the message is retried). */
  record(outcome: SendOutcome, campaignId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({ outcome, campaignId, resolve, reject });
      if (this.pending.length >= MAX_BATCH) void this.flush();
      else this.timer ??= setTimeout(() => void this.flush(), MAX_WAIT_MS);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;

    const events: CounterEvent[] = batch.flatMap(({ outcome, campaignId }) =>
      campaignId === undefined ? [] : [{ campaignId, deliveryId: outcome.id, status: outcome.result }],
    );
    try {
      await this.deliveries.applySendOutcomes(batch.map((p) => p.outcome));
      // If the counters fail, the messages are retried: their claims record the same results again without
      // sending, and the counters (applied once per delivery and state) catch up exactly.
      await this.counters.apply(events);
    } catch (error) {
      this.logger.warn({ err: error, results: batch.length }, 'send results not recorded, will retry');
      for (const p of batch) p.reject(error);
      return;
    }
    for (const p of batch) p.resolve();
  }
}
