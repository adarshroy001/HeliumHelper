import type { Migration } from '../infrastructure/migrations/index.js';

/** Campaign exports (M13): kept 7 days, listed per campaign newest first. */
const migration: Migration = {
  async up(db) {
    const existing = await db.listCollections({ name: 'exports' }, { nameOnly: true }).hasNext();
    if (!existing) await db.createCollection('exports');
    const exports = db.collection('exports');
    await exports.createIndex({ campaignId: 1, createdAt: -1 }, { name: 'campaign_created' });
    await exports.createIndex({ expireAt: 1 }, { name: 'expire_at', expireAfterSeconds: 0 });
  },
};

export default migration;
