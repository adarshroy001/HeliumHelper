import type { Migration } from '../infrastructure/migrations/index.js';

/** The campaigns module's collections and indexes (M10, docs/modules/messaging/data-model.md). */
const migration: Migration = {
  async up(db) {
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const name of ['campaigns', 'uploads']) {
      if (!existing.has(name)) await db.createCollection(name);
    }
    const campaigns = db.collection('campaigns');
    // Lists filtered by status, newest first (findPage pages by _id).
    await campaigns.createIndex({ status: 1, _id: -1 }, { name: 'status_id' });
    // The sweeper's due schedules.
    await campaigns.createIndex({ status: 1, 'schedule.at': 1 }, { name: 'status_schedule_at' });
  },
};

export default migration;
