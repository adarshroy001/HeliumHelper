# audit module

Records every state-changing admin action, as part of the change (F19).

## Owns

| Kind | Name | Notes |
| --- | --- | --- |
| Collection | `audit_log` (messaging DB) | Created by migration `0001-create-audit-log` |
| Index | `entity_at` `{ entity.type, entity.id, at: -1 }` | History of one entity |
| Index | `actor_at` `{ actor.userId, at: -1 }` (sparse) | What one admin user did |

No routes, no queues, no error codes.

## Using it

Import `AuditModule` and inject `AuditService`. Record inside the same transaction as the change:

```ts
await withTransaction(this.connection, async (session) => {
  await this.campaigns.start(id, session);
  await this.audit.record(
    { actor, action: 'campaign.start', entity: { type: 'campaign', id }, before: { status: 'draft' }, after: { status: 'running' } },
    session,
  );
});
```

- Only changed fields are stored, as `{ from, to }`. Never pass secrets or message bodies.
- `requestId` comes from the request context (or the message's correlation ID in a worker).
- A failed audit write fails the action.

## Retention

Entries are kept indefinitely for now: volume is low (admin actions only). Review at one year, or before the collection passes 1 GB; the likely change is a TTL index on `at` for entries older than two years, added by a migration.
