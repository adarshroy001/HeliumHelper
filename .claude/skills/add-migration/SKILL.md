---
name: add-migration
description: Add a MongoDB migration to helium-backend (indexes, collections or data changes in the messaging database). Use whenever a schema needs an index or existing documents must change.
---

# Add a migration

Every index, collection and data change in the messaging database is a migration (ADR-0005). They run once each, in order, before new code deploys.

## Steps

1. `pnpm migrate:create "add campaign status index"` → `src/migrations/NNNN-add-campaign-status-index.ts`. It fails until written.
2. Write `up(db)` with the driver's `Db` (not Mongoose models):
   ```ts
   const migration: Migration = {
     async up(db) {
       await db.collection('campaigns').createIndex({ status: 1, _id: -1 }, { name: 'status_id' });
     },
   };
   export default migration;
   ```
   - Name indexes explicitly. List queries need an index ending in `_id` for `findPage()`.
   - Create a collection only if missing: `if (!(await db.listCollections({ name }).hasNext())) await db.createCollection(name);`
   - Data changes filter on what's still to do, so a rerun after a partial failure is safe:
     `updateMany({ status: { $exists: false } }, { $set: { status: 'draft' } })`.
3. `pnpm migrate`, then `pnpm migrate:status` (local, against docker-compose).
4. Run it again: it must say `no pending migrations`.
5. Record the collection and index in the module README's "Owns" table.
6. Commit the migration with the code that needs it. New code must work both before and after it runs.

## Never

- Edit, rename or renumber a migration that has run anywhere: write a new one.
- Import models, services or anything from `src/modules` (lint fails).
- Rely on `autoIndex` or `syncIndexes` outside your machine.
- Write a migration that takes more than a few minutes: a big backfill is a background job.
- Touch the `main` database: it is read-only for this backend.
- Drop a field or collection that the previous version of the code still reads, in the same release.
