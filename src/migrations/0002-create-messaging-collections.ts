import type { Migration } from '../infrastructure/migrations/index.js';

/**
 * The messaging module's collections and indexes (M5, docs/modules/messaging/data-model.md). No partial indexes:
 * DocumentDB 4.0 doesn't support them, so uniqueness that applies to some documents uses sparse single fields.
 */
const migration: Migration = {
  async up(db) {
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const name of [
      'wa_accounts',
      'templates',
      'media',
      'deliveries',
      'inbound_messages',
      'conversations',
      'suppressions',
      'unmatched_statuses',
    ]) {
      if (!existing.has(name)) await db.createCollection(name);
    }

    await db
      .collection('wa_accounts')
      .createIndex({ phoneNumberId: 1 }, { name: 'phone_number_id', unique: true });
    await db
      .collection('templates')
      .createIndex({ accountId: 1, name: 1, language: 1 }, { name: 'account_name_language', unique: true });

    const deliveries = db.collection('deliveries');
    // One delivery per recipient per campaign.
    await deliveries.createIndex({ dedupeKey: 1 }, { name: 'dedupe_key', unique: true, sparse: true });
    // Feeding pending deliveries in order; recipients filtered by status.
    await deliveries.createIndex({ campaignId: 1, status: 1, seq: 1 }, { name: 'campaign_status_seq' });
    // Recipients unfiltered; export.
    await deliveries.createIndex({ campaignId: 1, seq: 1 }, { name: 'campaign_seq' });
    // Correlating statuses and replies by wamid.
    await deliveries.createIndex(
      { providerMessageId: 1 },
      { name: 'provider_message_id', unique: true, sparse: true },
    );
    // Contact timeline; frequency cap.
    await deliveries.createIndex({ to: 1, createdAt: -1 }, { name: 'to_created' });

    await db
      .collection('inbound_messages')
      .createIndex({ from: 1, receivedAt: -1 }, { name: 'from_received' });
    await db
      .collection('inbound_messages')
      .createIndex({ campaignId: 1, receivedAt: -1 }, { name: 'campaign_received', sparse: true });

    await db.collection('conversations').createIndex({ lastMessageAt: -1 }, { name: 'last_message' });
    await db
      .collection('conversations')
      .createIndex({ unread: 1, lastMessageAt: -1 }, { name: 'unread_last_message' });

    await db
      .collection('unmatched_statuses')
      .createIndex({ expireAt: 1 }, { name: 'expire_at', expireAfterSeconds: 0 });
  },
};

export default migration;
