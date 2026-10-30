import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DB } from '../../infrastructure/database/index.js';
import { AuditEntry, AuditEntrySchema } from './audit-entry.schema.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';

/** Import it in any module whose services change state for an admin, and inject `AuditService`. */
@Module({
  imports: [MongooseModule.forFeature([{ name: AuditEntry.name, schema: AuditEntrySchema }], DB.messaging)],
  providers: [AuditRepository, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
