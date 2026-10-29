import { Body, Injectable, Module, Param, Put } from '@nestjs/common';
import { getConnectionToken, InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { type Actor, CurrentActor, RequirePermissions, ROLE_PERMISSIONS } from '../src/common/auth/index.js';
import { InternalController } from '../src/common/http/index.js';
import { DB, withTransaction } from '../src/infrastructure/database/index.js';
import { AUDIT_COLLECTION, AuditModule, AuditService } from '../src/modules/audit/index.js';
import { createTestApp, type TestApp } from './helpers/create-test-app.js';
import { signToken } from './helpers/tokens.js';

const update = z.strictObject({ title: z.string(), status: z.string() });

/** Test-only service: changes a note and records it, in one transaction, as module services will. */
@Injectable()
class NotesService {
  constructor(
    @InjectConnection(DB.messaging) private readonly connection: Connection,
    private readonly audit: AuditService,
  ) {}

  async update(actor: Actor, id: string, after: z.infer<typeof update>): Promise<void> {
    const notes = this.connection.collection<{ _id: string; title: string; status: string }>('notes');
    await withTransaction(this.connection, async (session) => {
      const before = await notes.findOneAndUpdate({ _id: id }, { $set: after }, { session });
      await this.audit.record(
        {
          actor,
          action: 'note.update',
          entity: { type: 'note', id },
          before: { title: before?.title, status: before?.status },
          after,
        },
        session,
      );
    });
  }
}

@InternalController('notes')
@RequirePermissions('notes:write')
class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Put(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body({ schema: update }) body: z.infer<typeof update>,
  ): Promise<{ ok: true }> {
    await this.notes.update(actor, id, body);
    return { ok: true };
  }
}

@Module({ imports: [AppModule, AuditModule], controllers: [NotesController], providers: [NotesService] })
class NotesModule {}

describe('audit log', () => {
  let t: TestApp;
  let db: Connection;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp({
      module: NotesModule,
      override: (b) => b.overrideProvider(ROLE_PERMISSIONS).useValue({ editor: ['notes:write'] }),
    });
    db = t.app.get<Connection>(getConnectionToken(DB.messaging));
    token = await signToken({ act: { id: 'u7', email: 'ravi@heliumair.in', roles: ['editor'] } });
    for (const name of ['notes', AUDIT_COLLECTION]) {
      if (!(await db.db?.listCollections({ name }).hasNext())) await db.createCollection(name);
    }
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await db
      .collection<{ _id: string }>('notes')
      .replaceOne({ _id: 'n1' }, { title: 'Diwali sale', status: 'draft' }, { upsert: true });
  });

  const put = (body: object) =>
    request(t.http).put('/internal/v1/notes/n1').set('Authorization', `Bearer ${token}`).send(body);

  it('records the actor, the request ID and only the fields that changed', async () => {
    const res = await put({ title: 'Diwali sale', status: 'scheduled' });

    expect(res.status).toBe(200);
    const entry = await db.collection(AUDIT_COLLECTION).findOne({ requestId: res.headers['x-request-id'] });
    expect(entry).toMatchObject({
      actor: { service: 'helium-admin', userId: 'u7', email: 'ravi@heliumair.in' },
      action: 'note.update',
      entity: { type: 'note', id: 'n1' },
      changes: { status: { from: 'draft', to: 'scheduled' } },
    });
    expect(Object.keys(entry?.['changes'] as object)).toEqual(['status']);
    expect(entry?.['at']).toBeInstanceOf(Date);
  });

  it('fails the action, and keeps nothing of it, when the audit entry cannot be written', async () => {
    // Make every audit insert fail validation.
    await db.db?.command({
      collMod: AUDIT_COLLECTION,
      validator: { $jsonSchema: { required: ['never-present'] } },
    });
    try {
      const res = await put({ title: 'Changed', status: 'scheduled' });

      expect(res.status).toBe(500);
      expect(await db.collection('notes').findOne({ _id: 'n1' } as object)).toMatchObject({
        title: 'Diwali sale',
        status: 'draft',
      });
    } finally {
      await db.db?.command({ collMod: AUDIT_COLLECTION, validator: {} });
    }
  });
});
