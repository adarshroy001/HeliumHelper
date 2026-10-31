import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Actor } from '../../../common/auth/index.js';
import { AuditService } from '../../audit/index.js';
import { SuppressionsRepository } from '../data/messaging.repositories.js';
import { keys } from '../messaging.keys.js';
import { parsePhoneList } from '../whatsapp/phone.js';

/**
 * The suppression list: phones that must not get marketing messages. The database is the record; the Redis set is
 * the mirror the sender and the audience build check, updated with every change here.
 */
@Injectable()
export class SuppressionsService {
  constructor(
    private readonly redis: Redis,
    private readonly suppressions: SuppressionsRepository,
    private readonly audit: AuditService,
  ) {}

  /** The phones among `phones` that are suppressed, from the Redis mirror (one round trip). */
  async suppressedAmong(phones: readonly string[]): Promise<Set<string>> {
    if (phones.length === 0) return new Set();
    const flags = await this.redis.smismember(keys.suppressed(), ...phones);
    return new Set(phones.filter((_, i) => flags[i] === 1));
  }

  list(after: string | undefined, limit: number) {
    return this.suppressions.list(after, limit);
  }

  async add(phone: string, actor: Actor): Promise<boolean> {
    const added =
      (await this.suppressions.add([
        { _id: phone, reason: 'admin', by: actor.user?.email ?? actor.service },
      ])) > 0;
    await this.redis.sadd(keys.suppressed(), phone);
    if (added)
      await this.audit.record({ actor, action: 'suppression.add', entity: { type: 'phone', id: phone } });
    return added;
  }

  /** Lets marketing reach the phone again. The Redis mirror is updated first, so nobody is skipped by mistake. */
  async remove(phone: string, actor: Actor): Promise<boolean> {
    await this.redis.srem(keys.suppressed(), phone);
    const removed = await this.suppressions.remove(phone);
    if (removed)
      await this.audit.record({ actor, action: 'suppression.remove', entity: { type: 'phone', id: phone } });
    return removed;
  }

  /** Adds every valid phone in a pasted list or CSV; returns how many were new and the tokens that weren't phones. */
  async import(text: string, actor: Actor): Promise<{ added: number; invalid: string[] }> {
    const { phones, invalid } = parsePhoneList(text);
    const by = actor.user?.email ?? actor.service;
    let added = 0;
    for (let i = 0; i < phones.length; i += 1000) {
      const batch = phones.slice(i, i + 1000);
      added += await this.suppressions.add(
        batch.map((phone) => ({ _id: phone, reason: 'import' as const, by })),
      );
      if (batch.length > 0) await this.redis.sadd(keys.suppressed(), ...batch);
    }
    await this.audit.record({
      actor,
      action: 'suppression.import',
      entity: { type: 'suppressions', id: 'import' },
      after: { added, invalid: invalid.length },
    });
    return { added, invalid: invalid.slice(0, 100) };
  }
}
