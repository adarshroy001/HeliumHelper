# ADR-0005 · MongoDB access: Mongoose, named connections, migrations

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

- The existing Helium data lives in AWS DocumentDB, which speaks the MongoDB API. The storefront and HeliumAdmin both use Mongoose against it.
- The backend needs to read that data (for example, campaign audiences) and to own new data (messaging).
- More databases may come later.
- Today's problems include heavy unindexed queries and two apps writing the same collections.

## Decision

- **Mongoose via `@nestjs/mongoose`.** It matches the existing apps, so schemas can move over unchanged.
- **Named connections**, each with its own URI in config:
    - `main` is today's Helium database. It uses a **read-only** database user. A module gets write access to specific `main` collections only through an ADR.
    - `messaging` is a new database on the same cluster, with no extra cost. Moving it to its own cluster later is a change to its URI only.
    - Each module declares which connection its models use.
- **One owner per collection.** The owning module's repository is the only code that writes it.
- **Indexes and data changes go through `migrations/`** (F13): ordered, up-only scripts recorded in `_migrations` and run as a deploy step. `autoIndex` is off in production. `syncIndexes` is never run in production, because it can drop indexes.
- **Query rules:**
    - every list query is backed by an index;
    - pagination uses a cursor, not `skip`;
    - hot paths use `lean()` and `bulkWrite`;
    - transactions are used only when a use case needs atomicity across documents, and kept short;
    - no transaction is held for a whole request.

## Alternatives considered

- **The native `mongodb` driver:** a little faster, but a different model from the existing apps, which blocks moving schemas over.
- **Prisma:** limited MongoDB support, and no DocumentDB support.
- **A separate DocumentDB cluster for messaging now:** about $450–600 a month for isolation we don't need yet. Batched writes keep the load low. Revisit if load tests show checkout latency moving.
- **Writing to `main` freely:** repeats the current two-writers problem.

## Consequences

- DocumentDB isn't fully MongoDB-compatible. Integration tests run on MongoDB 7, and features we use are checked against DocumentDB's compatibility list.
- The legacy WhatsApp collections need a narrowly scoped write grant during the messaging migration (M8), recorded in its own ADR.
