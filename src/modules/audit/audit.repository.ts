import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { DB } from '../../infrastructure/database/index.js';
import { AuditEntry } from './audit-entry.schema.js';

/** The only code that writes `audit_log`. Entries are never updated or deleted. */
@Injectable()
export class AuditRepository {
  constructor(@InjectModel(AuditEntry.name, DB.messaging) private readonly model: Model<AuditEntry>) {}

  async insert(entry: AuditEntry, session?: ClientSession): Promise<void> {
    await this.model.create([entry], { session });
  }
}
