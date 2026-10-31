// Sends signed webhooks to the backend like Meta does: statuses batched per phone number every 50 ms, each POST
// signed with X-Hub-Signature-256, retried with backoff when the backend doesn't answer 200.
import { createHmac } from 'node:crypto';

export interface EmitterOptions {
  url: string;
  appSecret: string;
  wabaId: string;
  displayPhone: string;
  /** Statuses per POST. */
  batchSize?: number;
  flushMs?: number;
  /** Delivery attempts before a webhook is dropped (and counted). */
  attempts?: number;
}

export interface EmitterStats {
  posted: number;
  failed: number;
  pendingStatuses: number;
  inFlight: number;
}

type Value = Record<string, unknown>;

export class WebhookEmitter {
  readonly stats: EmitterStats = { posted: 0, failed: 0, pendingStatuses: 0, inFlight: 0 };
  private readonly pending = new Map<string, Value[]>();
  private readonly timer: NodeJS.Timeout;
  private readonly options: Required<EmitterOptions>;
  private closed = false;

  constructor(options: EmitterOptions) {
    this.options = { batchSize: 100, flushMs: 50, attempts: 5, ...options };
    this.timer = setInterval(() => {
      this.flush();
    }, this.options.flushMs);
  }

  /** Queues one status for its phone number; it goes out with the next batch. */
  status(phoneNumberId: string, status: Value): void {
    const list = this.pending.get(phoneNumberId) ?? [];
    list.push(status);
    this.pending.set(phoneNumberId, list);
    this.stats.pendingStatuses += 1;
  }

  /** Sends one `messages` change with inbound messages at once. */
  inbound(phoneNumberId: string, value: Value): void {
    this.post(this.body('messages', { ...this.metadata(phoneNumberId), ...value }));
  }

  /** Sends one account-level change (template status, quality, limits) at once. */
  account(field: string, value: Value): void {
    this.post(this.body(field, value));
  }

  /** Resolves when nothing is waiting or in flight. */
  async drain(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while ((this.stats.pendingStatuses > 0 || this.stats.inFlight > 0) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private flush(): void {
    for (const [phoneNumberId, statuses] of this.pending) {
      while (statuses.length > 0) {
        const batch = statuses.splice(0, this.options.batchSize);
        this.stats.pendingStatuses -= batch.length;
        this.post(this.body('messages', { ...this.metadata(phoneNumberId), statuses: batch }));
      }
      this.pending.delete(phoneNumberId);
    }
  }

  private metadata(phoneNumberId: string): Value {
    return {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: this.options.displayPhone, phone_number_id: phoneNumberId },
    };
  }

  private body(field: string, value: Value): string {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: this.options.wabaId, changes: [{ field, value }] }],
    });
  }

  private post(body: string, attempt = 1): void {
    if (this.closed) return;
    this.stats.inFlight += 1;
    const signature = `sha256=${createHmac('sha256', this.options.appSecret).update(body).digest('hex')}`;
    fetch(this.options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
      body,
      signal: AbortSignal.timeout(20_000),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        this.stats.posted += 1;
      })
      .catch(() => {
        if (attempt < this.options.attempts && !this.closed) {
          // A scheduled retry counts as in flight, so drain() waits for it.
          this.stats.inFlight += 1;
          setTimeout(
            () => {
              this.stats.inFlight -= 1;
              this.post(body, attempt + 1);
            },
            500 * 2 ** (attempt - 1),
          );
        } else {
          this.stats.failed += 1;
        }
      })
      .finally(() => {
        this.stats.inFlight -= 1;
      });
  }
}
