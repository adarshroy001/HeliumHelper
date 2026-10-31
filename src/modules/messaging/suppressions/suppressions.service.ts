import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { keys } from '../messaging.keys.js';

/** The suppression list as other modules use it: who must not get marketing messages. */
@Injectable()
export class SuppressionsService {
  constructor(private readonly redis: Redis) {}

  /** The phones among `phones` that are suppressed, from the Redis mirror (one round trip). */
  async suppressedAmong(phones: readonly string[]): Promise<Set<string>> {
    if (phones.length === 0) return new Set();
    const flags = await this.redis.smismember(keys.suppressed(), ...phones);
    return new Set(phones.filter((_, i) => flags[i] === 1));
  }
}
