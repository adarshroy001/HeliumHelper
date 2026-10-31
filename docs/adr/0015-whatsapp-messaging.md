# ADR-0015 · WhatsApp messaging: ledger, paced feeder, shared sender

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

HeliumAdmin sends WhatsApp campaigns with a single pm2 worker that uses MongoDB as its queue, and handles Meta's webhooks inside the request. The inventory in [docs/modules/messaging/README.md](../modules/messaging/README.md#what-exists-today) lists the consequences: one campaign at a time, an in-process rate limit that breaks with two instances, late `failed` statuses dropped, replies attached to the wrong campaign, no opt-out handling, audience building inside a 300-second request, and high database CPU.

The earlier design (Helium-Production `docs/architecture/messaging-platform/`, 12 docs) assumed a separate `helium-messaging` service on Fastify with its own DocumentDB cluster. ADRs 0002–0011 replaced that with this modular monolith. This ADR keeps that design's core ideas and records where it changes.

## Decision

- **Two modules.**
    - `messaging` owns the channel: WhatsApp accounts, templates, the delivery ledger, the sender, webhooks, statuses, inbound messages, suppressions and the inbox.
    - `campaigns` owns campaigns: drafts, audiences, the build, the feeder, the lifecycle, stats and exports.
    - `campaigns` uses `messaging` only through its exported service and message types.
- **One delivery ledger.** Every outbound WhatsApp message is one document in `deliveries`, whatever sent it (campaign, direct send, auto-reply), so there is one status pipeline and one inbox.
- **Build once, then feed at the allowed pace.** A campaign's audience is written once as `pending` deliveries. A single-leader feeder keeps about two minutes of work in the send queue. Pause and stop take effect within seconds, several campaigns share a number fairly, and a campaign can run for days.
- **One sender for every message,** reading priority queues (`wa-send-p1` for direct sends and auto-replies, `wa-send-p2` for campaigns), with:
    - a shared token bucket per phone number in Redis (Lua), keeping 20% for p1;
    - an adaptive rate that backs off on Meta's 130429;
    - results written in batches, one `bulkWrite` per flush.
- **Marketing sends are at most once.** A Redis claim (`SET NX`) is taken before the call to Meta. A send whose result is unknown (timeout after the request was written) keeps its claim and is settled by watching for a status webhook within 15 minutes, re-fed once at most. Everything else is at least once, with idempotent consumers.
- **Correlation without a database read.** Every send carries `biz_opaque_callback_data = "d:<deliveryId>"` (`d:<deliveryId>:<campaignId>` for a campaign), which Meta echoes back, so a status finds its delivery and its campaign's counters directly. The fallback is a Redis `wamid → deliveryId[:campaignId]` map, then the `providerMessageId` index.
- **Status transitions are ranked** (`pending 0 → accepted 1 → sent 2 → delivered 3 → read 4`). `failed` is accepted while the rank is below `delivered`, which fixes today's dropped failures. A Lua script applies each transition once and updates the live counters in the same step.
- **Webhooks are verified, split and queued; nothing else.**
    - The signature check and parser are plain TypeScript in `src/modules/messaging/whatsapp/`.
    - Today they run behind `POST /webhooks/whatsapp` in the API. The route touches no database and no Redis.
    - The Lambda in ADR-0011 can reuse the same code when we deploy; that choice is made then.
- **Scheduling without per-campaign AWS resources.** A scheduled campaign stores `schedule.at`. A sweeper message every minute starts due campaigns. It works the same locally and in AWS, and needs no IAM rights to create schedules. Start precision is one minute.
- **Files through a `BlobStore` interface,** for CSV audiences, header media and exports. A local-disk store is used now; an S3 store is added with the deployment.
- **No legacy v1 adapter.**
    - Meta allows one webhook URL per app. We switch it when no v1 campaign is sending.
    - Late statuses for old v1 messages are recorded in `unmatched_statuses` (7-day TTL).
    - v1 campaigns stay readable in HeliumAdmin from the old collections.
    - So the backend never needs write access to `main`.
- **Indexes avoid partial filters,** because DocumentDB 4.0 doesn't support them. A campaign recipient is unique through a single-field sparse unique `dedupeKey` (`<campaignId>:<phone>`).
- **The Marketing Messages API** (`/marketing_messages`) is used for marketing templates when the account enables it. Utility and service messages use the Cloud API (`/messages`). Meta stops delivering marketing messages through the Cloud API on 13 Oct 2027.

## Alternatives considered

- **Enqueue every recipient at start.** Stop can't remove messages already in SQS, one big campaign starves the others, and a slow campaign can outlive SQS retention.
- **Keep the database as the queue (today's design).** This is the cause of today's CPU load and the single-campaign limit.
- **One EventBridge schedule per campaign (the earlier design).** It needs IAM to create schedules and an emulator locally, for one-minute precision we get from the sweeper anyway.
- **A legacy adapter that writes v1 statuses into `main`.** A write grant on `main` for a few days of late statuses. Switching the webhook between campaigns avoids it.
- **BullMQ for the send queue.** Rejected in ADR-0006.

## Consequences

- Redis is on the send path. When it is down, the sender's and feeder's gates close and SQS holds the work (ADR-0007). Live counters can be rebuilt from the database with a reconcile command.
- The sender never reads the database: each send message carries everything needed to send.
- New channels (SMS, email) would add a provider adapter and their own queues, reusing the ledger and status pipeline.
- The design is checked end to end locally against `mock-meta`, a fake Graph API that sends signed webhooks back (M4, M16).
