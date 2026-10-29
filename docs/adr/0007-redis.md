# ADR-0007 · Redis (ElastiCache for Valkey) for coordination only

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Several API and worker instances must share state that changes many times a second: rate limits, send claims to prevent duplicate sends, live counters, locks and idempotency keys. A database is too slow and too expensive for that, and memory inside one process isn't shared.

## Decision

- **ElastiCache for Valkey.**
    - Node-based, with 1 primary and 1 replica, Multi-AZ.
    - TLS and authentication.
    - `maxmemory-policy noeviction`.
    - Locally it runs as the `valkey/valkey:8` container.
- **Redis is coordination only.**
    - It never holds data we can't rebuild from the database or afford to lose.
    - Every use documents what happens when Redis is unavailable or loses data.
- **Client:** ioredis.
- **Atomic multi-step operations** use Lua scripts loaded once with `defineCommand`, with keys always passed as arguments.
- **Key format:** `{domain}:{purpose}:{id}`. Keys that a script uses together share a hash tag (`{id}`), so a later move to cluster mode needs no changes.

## Alternatives considered

- **ElastiCache Serverless:** eviction isn't under our control.
- **MemoryDB:** durable Redis we don't need.
- **Counters in MongoDB:** cost and latency on every increment.
- **In-process memory:** not shared across instances. CrediTouch's in-memory rate limits multiplied with each instance.

## Consequences

- Workers that depend on Redis fail closed when it is down: they stop consuming, and SQS buffers the work.
- Redis has its own memory and CPU alarms.
