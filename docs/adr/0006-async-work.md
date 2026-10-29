# ADR-0006 · Async work: SQS queues, worker processes, scheduled jobs

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Helium does slow and external work inside web requests: sending messages, processing webhooks, and running campaigns with the database as the queue. That causes lost work, no retries, and high database CPU.

## Decision

- **Amazon SQS is the work queue.**
    - Standard queues handle high volume.
    - Standard **fair queues** (`MessageGroupId` = tenant, such as a campaign) are used where several producers share a queue.
    - **FIFO** queues are used only where order per key matters.
    - **Every queue has a DLQ** and alarms on oldest-message age and DLQ depth.
- **Every message uses one envelope** (`v`, `id`, `type`, `ts`, `producer`, `correlationId`, `data`), validated with zod on both sides.
- **The worker process** (`src/worker.ts`) runs consumers declared with `@Consumer()`:
    - the `WORKER_QUEUES` setting chooses which consumers a process runs, so one image runs as several ECS services that scale independently;
    - handlers return an outcome: `ack`, `retry`, `park` (to the DLQ) or `hold`;
    - consumers are idempotent;
    - on SIGTERM the worker finishes in-flight work and exits.
- **Scheduled jobs** are declared in a typed registry in code.
    - In AWS, each one becomes an EventBridge Scheduler schedule that puts a message on a queue, and a normal consumer handles it.
    - Locally, a dev timer publishes the same messages.
    - No crontab, no in-process cron in the API.
- **EventBridge (the event bus)** is for low-volume domain events that several consumers subscribe to, such as `order.paid`. It is added when the first such event exists, never on a hot path.

## Alternatives considered

- **RabbitMQ (Amazon MQ):** a broker to size and patch, with no delayed-message plugin on Amazon MQ.
- **BullMQ on Redis:** the backlog lives in RAM, durability depends on Redis persistence, and per-group rate limits are a paid feature.
- **Kafka (MSK):** built for streams and replay. It is operationally heavy and has no per-message retry.
- **The database as a queue:** the cause of today's CPU problem.
- **`@nestjs/schedule` in the API:** every API instance would run the cron, and nothing records whether a run failed.

## Consequences

- Local development uses ElasticMQ, which is SQS-compatible. Fair-queue group IDs are switched off there by config.
- Every new kind of background work means a queue, a DLQ, a consumer and an alarm. The `add-consumer` skill (F21) gives the steps.
