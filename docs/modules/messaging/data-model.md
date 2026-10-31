# Messaging data model

All collections are in the `messaging` database ([ADR-0005](../../adr/0005-database.md)) and are created, with their indexes, by migrations. Indexes are few on purpose, because every index makes writes more expensive, and none uses a partial filter (DocumentDB 4.0 doesn't support them). Redis keys can all be rebuilt from the database or safely lost ([ADR-0007](../../adr/0007-redis.md)).

## Collections

| Collection | Owner | Key fields | Indexes |
| --- | --- | --- | --- |
| `wa_accounts` | messaging | `_id` (`main`), `wabaId`, `portfolioId`, `phoneNumberId`, `displayPhone`, `marketingEndpoint` (`marketing_messages` or `messages`), `maxMps`, `quality`, `messagingLimit`, `status` (`active` or `paused`), `pauseReason` | `{phoneNumberId:1}` unique |
| `templates` | messaging | `_id` = Meta template ID, `accountId`, `name`, `language`, `category`, `status`, `quality`, `components`, `syncedAt` | `{accountId:1, name:1, language:1}` unique |
| `media` | messaging | `blobKey`, `mime`, `size`, `accountId`, `metaMediaId`, `uploadedToMetaAt`, `createdBy` | none beyond `_id` |
| `deliveries` | messaging | see below | see below |
| `inbound_messages` | messaging | `_id` = wamid, `accountId`, `from`, `type`, `text`, `button{text,payload}`, `media{id,mime}`, `contextWamid`, `deliveryId`, `campaignId`, `receivedAt` | `{from:1, receivedAt:-1}`, `{campaignId:1, receivedAt:-1}` sparse |
| `conversations` | messaging | `_id` = phone, `accountId`, `lastMessageAt`, `lastInboundAt`, `lastDirection`, `lastPreview` (first 80 characters), `unread`, `userId` | `{lastMessageAt:-1}`, `{unread:1, lastMessageAt:-1}` |
| `suppressions` | messaging | `_id` = phone, `reason` (`keyword`, `button`, `admin`, `import`), `source`, `by`, `createdAt` | `_id` only |
| `unmatched_statuses` | messaging | the raw status, `wamid`, `phoneNumberId`, `receivedAt`, `expireAt` | TTL on `expireAt` (7 days) |
| `campaigns` | campaigns | see below | `{status:1, createdAt:-1}`, `{createdAt:-1}`, `{status:1, "schedule.at":1}` |
| `exports` | campaigns | `campaignId`, `status`, `blobKey`, `rows`, `requestedBy`, `expireAt` | `{campaignId:1, createdAt:-1}`, TTL on `expireAt` (7 days) |
| `audit_log` | audit | exists ([audit README](../../../src/modules/audit/README.md)) | exists |

### `deliveries`

```json
{ "_id": "6650c1f2a1b2c3d4e5f60719",
  "source": { "kind": "campaign", "id": "6650c1f2a1b2c3d4e5f60718" },
  "campaignId": "6650c1f2a1b2c3d4e5f60718", "seq": 1042, "dedupeKey": "6650c1f2a1b2c3d4e5f60718:919876543210",
  "accountId": "main", "to": "919876543210", "userId": "64f…", "name": "Asha",
  "payload": { "kind": "template", "template": { "name": "diwali_sale", "language": { "code": "en" }, "components": [] } },
  "status": "delivered", "statusRank": 3, "providerMessageId": "wamid.HBgM…",
  "acceptedAt": "…", "sentAt": "…", "deliveredAt": "…", "readAt": null, "failedAt": null,
  "error": null, "skipReason": null, "unconfirmedRetry": false,
  "pricing": { "category": "marketing", "billable": true },
  "reply": { "firstAt": "…", "lastAt": "…", "count": 2, "lastButton": "Yes" },
  "createdAt": "…" }
```

- `source.kind` is `campaign`, `direct`, `auto_reply` or `test`.
- `_id` is an ObjectId, except auto-replies, whose deterministic `_id` makes them idempotent.
- `name` and `userId` are kept for the recipients table and export; nothing else personal is copied.
- `status`: `pending`, `accepted`, `sent`, `delivered`, `read`, `failed`, `skipped`.

| Index | For |
| --- | --- |
| `{dedupeKey:1}` unique, sparse | One delivery per recipient per campaign |
| `{campaignId:1, status:1, seq:1}` | Feeding pending deliveries in order; the recipients table filtered by status |
| `{campaignId:1, seq:1}` | The recipients table, unfiltered; export |
| `{providerMessageId:1}` unique, sparse | Correlating statuses and replies by wamid |
| `{to:1, createdAt:-1}` | The contact timeline; the frequency cap |

### `campaigns`

| Field | Holds |
| --- | --- |
| `name`, `accountId`, `status`, `version` | Basics; `version` guards concurrent commands |
| `template` | `{ templateId, name, language, category, components }`, a snapshot taken at create |
| `variableMapping[]` | `{ index, component: HEADER\|BODY\|BUTTONS, buttonIndex?, source: field\|static\|csv, value }` (HeliumAdmin's shape) |
| `headerMedia` | `{ type: image\|video\|document, mediaId }` (a `media` document) |
| `audience` | `{ sources[], individual[], csv?: { blobKey, rows, columns, phoneColumn }, exclusions?: { blobKey, count }, retarget?: { campaignId, outcome, button? } }` |
| `options` | `{ frequencyCapHours, sendWindow?: { start: "10:00", end: "21:00" }, maxMps?, attributionDays }` |
| `autoReply` | `{ enabled, mode: text\|template, trigger: any_button\|any_reply, text?, template?, choiceReplies[] }` (HeliumAdmin's shape) |
| `schedule` | `{ at }` while `scheduled` |
| `build` | `{ seq, processed, heartbeatAt, error }` |
| `feed` | `{ cursor, exhausted }` |
| `totals` | `{ total, skipped: { invalid, suppressed, duplicate, frequency, excluded } }` |
| `pauseReason`, `stopReason` | Why it paused or stopped |
| `countsSnapshot` | The counters saved at close |
| `createdBy` | `{ userId, email, name }` from the token's `act` claim |
| Times | `createdAt`, `builtAt`, `sendStartedAt`, `sendCompletedAt`, `stoppedAt`, `closedAt` |

## Redis keys

Built with `redisKey(domain, purpose, id)`; the part in `{}` is the hash tag, and keys used together in one script share it.

| Key | Type | TTL | Written by | Purpose |
| --- | --- | --- | --- | --- |
| `cfg:wa:pause:{global}` | string | none | API (ops) | Kill switch |
| `wa:rl:{pn}` | hash `tokens`, `ts` | 60 s, refreshed | sender (Lua) | Token bucket |
| `wa:rate:{pn}` | hash `rate`, `last429`, `lastUp` | none | sender (Lua) | Adaptive rate |
| `wa:pause:{pn}` | string | the pause | sender, account consumer | Number pause |
| `wa:acct:{accountId}` | string | none | workers, API | Account paused |
| `wa:camp:{cid}` | string | removed at close | API, control | `sending`, `paused` or `stopped` |
| `wa:active:{global}` | set | none | control | The feeder's campaigns |
| `wa:feed:{cid}` | hash `cursor` | removed at close | feeder | Feed position |
| `wa:cnt:{cid}` | hash | removed at close | Lua | Live counters |
| `wa:st:{cid}` | hash deliveryId → rank | removed at close | Lua | Idempotent transitions (about 80 MB per 1M recipients) |
| `wa:btn:{cid}` | hash button → count | removed at close | inbound | Poll results |
| `wa:claim:{deliveryId}` | string `inflight` or `ok:{wamid}` | 3 days | sender | At-most-once send |
| `wa:wamid:{wamid}` | string deliveryId | 3 days | sender | Correlation fallback |
| `wa:unconfirmed:{global}` | sorted set (score = time) | none | sender, sweeper | Unknown results |
| `wa:uniq:{portfolioId}:{yyyyMMddHH}` | HyperLogLog | 26 h | sender | Daily messaging limit |
| `wa:csw:{phone}` | string | 24 h | inbound | Service window open |
| `wa:supp:{global}` | set | none | inbound, API | Suppression mirror, reloaded from `suppressions` at start and every 10 minutes |
| `wa:feeder:{lock}` | string | PX 15 s | feeder | Leader election |

At 1M sends a day, claims and the wamid map peak around 0.5 GB.

## Lua scripts

| Script | Keys | Arguments | Returns |
| --- | --- | --- | --- |
| `takeTokens` | `wa:rl:{pn}`, `wa:rate:{pn}` | want, priority, reserve fraction, now (ms) | Tokens granted |
| `refundTokens` | `wa:rl:{pn}` | n | — |
| `onRateLimited` | `wa:rate:{pn}`, `wa:pause:{pn}` | factor 0.7, floor, pause (ms), now | New rate |
| `maybeRaiseRate` | `wa:rate:{pn}` | step 1.05, maxMps, quiet (ms), now | New rate |
| `transition` | `wa:st:{cid}`, `wa:cnt:{cid}` | deliveryId, status, pricing category | `applied`, previous rank |

`transition` in brief:

```lua
local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if ARGV[2] == 'failed' then
  if cur >= 3 or cur == -1 then return {0, cur} end
  redis.call('HSET', KEYS[1], ARGV[1], -1); redis.call('HINCRBY', KEYS[2], 'failed', 1); return {1, cur}
end
local new = RANK[ARGV[2]]                       -- accepted 1, sent 2, delivered 3, read 4
if new <= cur or cur == -1 then return {0, cur} end
redis.call('HSET', KEYS[1], ARGV[1], new)
for r = cur + 1, new do redis.call('HINCRBY', KEYS[2], NAME[r], 1) end   -- read also counts delivered
return {1, cur}
```

## Queues

| Queue | Type | Consumer | Visibility | Max receives |
| --- | --- | --- | --- | --- |
| `wa-status` | Standard | status | 60 s | 10 (allows unmatched holds) |
| `wa-inbound` | Standard | inbound | 60 s | 5 |
| `wa-account` | Standard | account | 60 s | 5 |
| `wa-send-p1` | Standard | sender | 30 s | 15 |
| `wa-send-p2` | Standard (fair, `groupId = campaignId`) | sender | 30 s | 15 |
| `campaign-control` | Standard | control | 300 s (builds heartbeat) | 5 |
| `messaging-jobs` | Standard | jobs (sweeper, template sync, suppression reload) | 120 s | 5 |

Each has a `-dlq`, alarms on oldest-message age and DLQ depth (deploy/config/queues.ts), and an entry in docker/elasticmq.conf.

## Message types

| Type | Queue | Data |
| --- | --- | --- |
| `wa.webhook.status` | `wa-status` | `{ receivedAt, wabaId, phoneNumberId, value }` |
| `wa.webhook.inbound` | `wa-inbound` | the same |
| `wa.webhook.account` | `wa-account` | the same, with `field` |
| `wa.delivery.send` | `wa-send-p1`, `wa-send-p2` | the send message ([design.md](design.md#the-send-message)) |
| `campaign.command.run` | `campaign-control` | `{ campaignId, command }`: `build` (M11), `start`, `stop`, `export`, `test` (M12–M13) |
| `messaging.job.run` | `messaging-jobs` | `{ job }`: `templates-sync`, `suppressions-reload` |
