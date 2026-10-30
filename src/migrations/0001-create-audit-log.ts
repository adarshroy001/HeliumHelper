import type { Migration } from '../infrastructure/migrations/index.js';

/** The audit log (F19): the collection and the indexes its reads use. */
const migration: Migration = {
  async up(db) {
    const exists = await db.listCollections({ name: 'audit_log' }).hasNext();
    if (!exists) await db.createCollection('audit_log');
    const audit = db.collection('audit_log');
    // History of one entity, newest first.
    await audit.createIndex({ 'entity.type': 1, 'entity.id': 1, at: -1 }, { name: 'entity_at' });
    // What one admin user did, newest first.
    await audit.createIndex({ 'actor.userId': 1, at: -1 }, { name: 'actor_at', sparse: true });
  },
};

export default migration;
