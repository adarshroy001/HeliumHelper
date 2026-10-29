---
name: add-consumer
description: Add background work to helium-backend - a message type, an SQS queue with its DLQ, a @Consumer handler, local and AWS queue config, and tests. Use when work must run outside a request or on a schedule.
---

# Add a consumer

## Steps

1. **Message type and queue name** in `<module>.messages.ts`:
   ```ts
   export const DELIVERY_QUEUE = 'wa-send';
   export const deliverySend = defineMessage('wa.delivery.send', z.strictObject({ deliveryId: z.string() }));
   ```
   Type names are `{domain}.{noun}.{verb}`.
2. **Handler**, a provider of the module:
   ```ts
   @Consumer({ queue: DELIVERY_QUEUE, message: deliverySend, concurrency: 10, visibilitySeconds: 60 })
   export class DeliverySendConsumer implements MessageHandler<DeliverySend> {
     async handle(data: DeliverySend, { envelope, receiveCount }: ReceivedMessage<DeliverySend>) {
       ...
       return ack();   // or retry(seconds?), park(reason), hold(seconds)
     }
   }
   ```
   - Idempotent by a natural key (`deliveryId`): SQS can deliver twice.
   - Throw a retryable error to retry; an `AppError` with `retryable: false` parks.
   - Optional `gate()` returns `false` to pause consuming (for example when Redis is down).
3. **Wire it**: the module in `src/worker.module.ts` imports; the handler in its `providers`.
4. **Queue locally**: add `helium-local-<queue>` and `helium-local-<queue>-dlq` to `docker/elasticmq.conf` (copy the `system-jobs` entry), then `docker compose restart elasticmq`.
5. **Queue in AWS**: add it to `deploy/config/queues.ts` (visibility, max receives, alarm thresholds).
6. **Producer**: inject `QueuePublisher`; `publish(DELIVERY_QUEUE, deliverySend, data, { groupId? })`.
7. **Schedule** (if it runs on a timetable): `defineSchedule()` in `<module>.schedules.ts`, add it to `src/schedules.ts`, run `pnpm schedules:export`.
8. **Tests**: unit-test the handler's decisions; for queue behaviour, `createTestQueue()` + `QueuePublisher` against ElasticMQ (see `consumer-loop.int-spec.ts`).
9. Document the queue, message and consumer in the module README; run `WORKER_QUEUES=<queue> pnpm dev` and watch it work.

## Never

- Do the work inside an HTTP request instead (R11).
- Delete a message yourself, or catch every error and `ack()`: failures must retry or park.
- Assume order or exactly-once delivery on a standard queue.
- Publish a payload that isn't validated by its message type (the publisher refuses).
- Run a cron inside the API or with `setInterval`: use a schedule.
