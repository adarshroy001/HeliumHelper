import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import type { Actor } from '../../common/auth/index.js';
import type { AuditEntry } from './audit-entry.schema.js';
import { AuditRepository } from './audit.repository.js';

export interface AuditInput {
  actor: Actor;
  /** `{entity}.{verb}`: `campaign.start`, `template.sync`. */
  action: `${string}.${string}`;
  entity: { type: string; id: string };
  /** The entity's fields before and after; only the ones that differ are stored. Never pass secrets. */
  before?: Readonly<Record<string, unknown>>;
  after?: Readonly<Record<string, unknown>>;
}

/** The fields whose values differ, each as `{ from, to }`. */
export function changedFields(
  before: Readonly<Record<string, unknown>> = {},
  after: Readonly<Record<string, unknown>> = {},
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!isDeepStrictEqual(before[key], after[key])) changes[key] = { from: before[key], to: after[key] };
  }
  return changes;
}

/**
 * Records state-changing admin actions. Services call it explicitly, as part of the change: pass the
 * transaction's `session` so the action and its audit entry commit together. A failed audit write fails the
 * action; it is never best-effort.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly cls: ClsService,
  ) {}

  async record(input: AuditInput, session?: ClientSession): Promise<void> {
    const changes = changedFields(input.before, input.after);
    const { user } = input.actor;
    const entry: AuditEntry = {
      actor: {
        service: input.actor.service,
        ...(user === undefined ? {} : { userId: user.id, email: user.email }),
      },
      action: input.action,
      entity: input.entity,
      ...(Object.keys(changes).length === 0 ? {} : { changes }),
      requestId: this.cls.isActive() ? this.cls.getId() : 'none',
      at: new Date(),
    };
    await this.repository.insert(entry, session);
  }
}
