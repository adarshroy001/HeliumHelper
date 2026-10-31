import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { runScript } from '../../../infrastructure/redis/index.js';
import { keys } from '../messaging.keys.js';
import { maybeRaiseRate, onRateLimited, takeTokens } from './rate-limit.scripts.js';

/** Share of a number's capacity campaign sends leave free for direct sends and auto-replies. */
const RESERVE = 0.2;
/** Tokens asked for in one script call. */
const MAX_BATCH = 50;
/** How often each number's rate may be raised again after a quiet spell. */
const RAISE_EVERY_MS = 5_000;

export type Priority = 1 | 2;

interface Waiter {
  readonly priority: Priority;
  resolve(): void;
  reject(error: unknown): void;
}

interface NumberState {
  readonly waiters: Waiter[];
  pumping: boolean;
  lastRaise: number;
}

/**
 * Hands out send tokens for each phone number from the shared Redis bucket (design.md#rate-limits). Callers wait
 * in line; one loop per number asks Redis for as many tokens as there are callers waiting, so the bucket sees one
 * script call per batch, not one per message. Priority 1 callers are served first.
 */
@Injectable()
export class RateLimiter {
  private readonly numbers = new Map<string, NumberState>();

  constructor(private readonly redis: Redis) {}

  /** Waits for one token. Rejects if Redis fails, so the message is retried later. */
  acquire(phoneNumberId: string, priority: Priority, maxMps: number): Promise<void> {
    const state = this.numbers.get(phoneNumberId) ?? { waiters: [], pumping: false, lastRaise: 0 };
    this.numbers.set(phoneNumberId, state);
    const granted = new Promise<void>((resolve, reject) => {
      state.waiters.push({ priority, resolve, reject });
    });
    if (!state.pumping) void this.pump(phoneNumberId, state, maxMps);
    return granted;
  }

  /** Meta said 130429 (over the rate) or 131057 (number upgrading): slow down and pause the number. */
  async rateLimited(phoneNumberId: string, kind: 'throughput' | 'upgrading', maxMps: number): Promise<void> {
    const [factor, floor, pauseMs] = kind === 'throughput' ? [0.7, 10, 2_000] : [1, 1, 60_000];
    await runScript(
      this.redis,
      onRateLimited,
      [keys.rate(phoneNumberId), keys.numberPause(phoneNumberId)],
      [factor, floor, pauseMs, Date.now(), maxMps],
    );
  }

  private async pump(phoneNumberId: string, state: NumberState, maxMps: number): Promise<void> {
    state.pumping = true;
    try {
      while (state.waiters.length > 0) {
        this.maybeRaise(phoneNumberId, state, maxMps);
        const priority: Priority = state.waiters.some((w) => w.priority === 1) ? 1 : 2;
        const queue = state.waiters.filter((w) => w.priority === priority);
        const [granted, waitMs] = await runScript(
          this.redis,
          takeTokens,
          [keys.bucket(phoneNumberId), keys.rate(phoneNumberId), keys.numberPause(phoneNumberId)],
          [Math.min(queue.length, MAX_BATCH), priority, RESERVE, Date.now(), maxMps],
        );
        for (const waiter of queue.slice(0, granted)) {
          state.waiters.splice(state.waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
        if (granted === 0) await sleep(Math.min(waitMs, 1_000));
      }
    } catch (error) {
      for (const waiter of state.waiters.splice(0)) waiter.reject(error);
    } finally {
      state.pumping = false;
    }
  }

  private maybeRaise(phoneNumberId: string, state: NumberState, maxMps: number): void {
    const now = Date.now();
    if (now - state.lastRaise < RAISE_EVERY_MS) return;
    state.lastRaise = now;
    runScript(this.redis, maybeRaiseRate, [keys.rate(phoneNumberId)], [1.05, maxMps, 30_000, now]).catch(
      () => undefined,
    );
  }
}
