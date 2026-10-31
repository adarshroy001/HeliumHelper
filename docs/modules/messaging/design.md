# Messaging design

How each part works. Names of collections, keys and queues are defined in [data-model.md](data-model.md); endpoints in [api.md](api.md); decisions in [ADR-0015](../../adr/0015-whatsapp-messaging.md).

## Targets

| Goal | Target |
| --- | --- |
| Send rate | 90% or more of the number's allowed rate (80 msg/s by default, up to 1,000), sustained |
| Webhook response | 200 in under 250 ms median; the route touches no database and no Redis |
| Status lag | Webhook received to delivery updated: p95 under 30 s |
| Pause or stop takes effect | Under 5 s |
| Duplicate marketing sends | 0, by design |
| Lost webhooks | 0: every failure ends in a DLQ with an alarm |
| Main DB load | Read-only audience reads from a secondary, throttled; no writes |
| Scale | A 10M-recipient campaign needs no design change |

## Webhooks

`GET /webhooks/whatsapp` answers Meta's verification: `hub.mode=subscribe` and the right `hub.verify_token` return `hub.challenge` as text; anything else is 403.

`POST /webhooks/whatsapp`:

1. Read the raw body and verify `X-Hub-Signature-256` (HMAC-SHA256 with the app secret, constant-time compare). Two secrets are accepted during rotation. A bad signature is 401 and nothing is queued.
2. For each `entry[].changes[]`, build `{ receivedAt, wabaId, phoneNumberId, field, value }` and route it:
    - `messages` with `statuses` → `wa-status`;
    - `messages` with `messages` → `wa-inbound`;
    - any other field → `wa-account` (an unknown field is logged).
3. Publish in batches. If anything stays unsent, answer 503 `WEBHOOK_NOT_QUEUED` so Meta retries (duplicates are safe); otherwise 200 with an empty body. A signed body that isn't a WhatsApp payload is logged and answered 200, because retrying can't fix it.

The route is `@Public()` (the signature is its authentication), served under the `/webhooks` prefix (`@WebhookController('whatsapp')`), not counted by the caller rate limit, and hidden from the API docs. Meta retries failed webhooks for up to 7 days and can deliver duplicates, so every consumer is idempotent.

## Sending

### Priority queues

| Queue | Carries | Notes |
| --- | --- | --- |
| `wa-send-p1` | Direct sends, free-text replies, auto-replies, test sends | Standard |
| `wa-send-p2` | Campaign sends | Standard, fair queue with `groupId = campaignId` |

The sender polls p1 first and moves to p2 only when p1 returned nothing on its last receive.

### The send message

`wa.delivery.send` carries everything needed to send, so the sender never reads the database:

```json
{ "deliveryId": "6650c1f2a1b2c3d4e5f60719", "accountId": "main", "phoneNumberId": "1234567890",
  "to": "919876543210", "endpoint": "marketing_messages", "campaignId": "6650c1f2a1b2c3d4e5f60718",
  "payload": { "kind": "template", "template": { "name": "diwali_sale", "language": { "code": "en" }, "components": [] } },
  "businessInitiated": true, "unconfirmedRetry": false }
```

### Sender loop

```text
gate:     kill switch, account paused, or number paused until T → don't receive
tokens:   k = takeTokens(phoneNumberId, want = batch size, priority)   (Lua; p2 leaves 20% for p1)
receive:  up to k messages; refund the unused tokens
for each message:
  campaign state (1 s local cache): stopped → skipped; paused → ack (it stays pending in the DB)
  suppressed (wa:supp) and businessInitiated → skipped
  claim:    SET wa:claim:{id} inflight NX EX 3 days (whole batch pipelined, then WAIT 1)
            already claimed → ack, nothing sent
  call Meta: POST /{v}/{phoneNumberId}/{messages|marketing_messages}, biz_opaque_callback_data = "d:{id}"
  result:   ok          → claim = ok:{wamid}; SET wa:wamid:{wamid} = id (3 days); buffer accepted
            Permanent   → buffer failed {code}
            RateLimited → release claim; slow the number down; hold the message
            Retryable   → release claim; retry with backoff
            Fatal       → release claim; pause the account; alert; hold 15 min
            Ambiguous   → keep the claim; ZADD wa:unconfirmed now id; ack
flush:    every 500 ms or 500 results: ONE deliveries.bulkWrite, then counters, then delete the messages
```

The database write comes before the SQS delete. If the task dies after Meta accepted a message, the message comes back, finds its claim, and is skipped; the status webhook then fills in the delivery, because it carries our delivery ID.

How it is built (`src/modules/messaging/sending/`):

- Each message is handled on its own by the consumer framework (up to 200 in flight per process on p2, 50 on p1). Batching comes from two shared parts: the `RateLimiter` asks Redis for as many tokens as there are handlers waiting on a number, and the `SendFlusher` writes every result from the last 200 ms (or 500 results) in one `bulkWrite`; each handler's message is deleted only after its batch is written.
- A campaign delivery is sent only while its campaign's Redis state is `sending`. A missing state (not started, or Redis lost it) means not now: the delivery stays pending.
- The delivery goes into `wa:unconfirmed` as soon as it is claimed, before the call, and leaves it on a definite result. A process that dies mid-call leaves it there for the sweeper.
- A retryable failure is retried with backoff up to 5 attempts, then the delivery is marked failed (`gave up after 5 attempts`).
- If the database write or the counters fail, the whole batch is retried: each message's claim records its result again without sending, and the counters (once per delivery and state) catch up exactly.
- A campaign-level fatal error (the template doesn't exist) sets the campaign's state to `paused` and writes the reason to `wa:camp-pause:{campaignId}`; the campaign sweeper (M12) records the pause on the campaign. An account-level fatal error (token, ban) sets `wa:acct-paused:{main}` and pauses the account in `wa_accounts`; the gate then stops all receiving.
- `WAIT 1` after a claim runs only when the Redis primary has a replica (ElastiCache), not locally.

### Rate limits

| Limit | Scope | How |
| --- | --- | --- |
| Throughput (80 msg/s default, up to 1,000; inbound and outbound together) | Phone number | Token bucket `wa:rl:{pn}`, capacity = 1 s of rate. p2 takes tokens only while 20% stays free |
| Adaptive rate | Phone number | `wa:rate:{pn}` starts at the account's `maxMps`. 130429: rate × 0.7 (floor 10) and a 2 s pause. After 30 s without one: rate × 1.05, up to `maxMps` |
| Number upgrading (131057) | Phone number | Pause 60 s |
| Speed cap | Campaign | The feeder feeds no faster than the campaign's `maxMps` |
| Daily messaging limit (unique users in 24 h) | Business portfolio | Hourly HyperLogLog `wa:uniq:{portfolioId}:{yyyyMMddHH}`; the feeder stops feeding marketing at 95% of the limit and shows `waitingForLimit` |
| Pair limit (131056) | Number and user | Hold the message 10 s |
| Per-user marketing cap (131049) | User, across businesses | Permanent for this campaign |

### Errors

Ported from HeliumAdmin `src/lib/whatsapp/errors.ts` and extended:

| Class | Meta codes | Action |
| --- | --- | --- |
| Retryable | network error before the request was written, HTTP 5xx, 1, 2, 4, 17, 80007, 131016, 133004 | Retry after 30 s, 2 m, 8 m, 30 m, 2 h (±20%); then the DLQ |
| RateLimited | 130429, 131056, 131057 | Close the gate for the number or hold the message (above) |
| Permanent | 130403, 131026, 131047, 131049, 131050, 132000, 132012, 132015, 132016; validation errors | Record the failure; no retry |
| Fatal | 0, 190, 368, 131031, 131042, 131048, 131064, 132001, 133010 | Pause the account (190, 131031, 131042, 368) or the campaign (132001, template problems), alert, hold |
| Ambiguous | timeout or reset after the request was written | Keep the claim; settle later (below) |

An unknown code is Retryable and logged with `unknownCode: true`.

### Unknown results

Every minute the sweeper reads `wa:unconfirmed` entries older than 15 minutes:
- if a status arrived or the claim reads `ok:…`, it removes the entry;
- otherwise it releases the claim and re-feeds the delivery once (`unconfirmedRetry: true`). A second unknown result marks it `failed` with reason `unconfirmed`.

### HTTP client

- Node's `fetch` (undici) with keep-alive.
- Timeouts: 3 s to connect, 10 s for the response.
- No automatic retries: retrying is the queue's job.
- The Graph version comes from config (`WA_GRAPH_VERSION`, v26.0).

### Service window and message kinds

- Templates can be sent at any time.
- Free-form messages (text, media) need an open customer service window. The inbound consumer sets `wa:csw:{phone}` (24 h) on every inbound message, and the API refuses free-form sends without it. Meta's 131047 is Permanent.

## Statuses

The status consumer takes up to 500 statuses or 1 s of them, whichever comes first, then for each:

1. **Correlate** it to a delivery: `biz_opaque_callback_data` (`d:<deliveryId>[:<campaignId>]`), else `wa:wamid:{wamid}` (same value without `d:`), else the `providerMessageId` index. If none match, retry the message in 30 s, up to 5 receives, then write the unmatched statuses to `unmatched_statuses` and ack (the matched ones are applied each time; applying them again changes nothing).
2. **Campaign deliveries:** a pipelined Lua `transition(campaignId, deliveryId, status)` says whether the transition applies, and updates the counters in the same step.
3. **Other deliveries:** a conditional database update only.
4. **Write** the applied transitions in one `bulkWrite`, each filtered by `{ _id, statusRank: { $lt: newRank } }`. This sets the status, its time, the error and the pricing category.
5. Confirm each status's send: remove the delivery from `wa:unconfirmed` and set its claim to `ok:<wamid>`.
6. Ack what was written; retry the rest. Counters are moved before the database write, so a retry after a failed write finds them already counted.

Billable messages are counted per pricing category (`billable:<category>`), once per delivery, from whichever of its statuses brings the pricing (`countBillable`: `HSETNX wa:billed:{campaignId}`), so the order statuses arrive in doesn't matter.

### Ranks and counters

```text
pending 0 → accepted 1 → sent 2 → delivered 3 → read 4
failed:  allowed while the rank is below 3 (also after accepted or sent)
skipped: only from pending (stop, suppression, invalid, duplicate, frequency cap)
```

Counters count deliveries that ever reached a state: `read` also counts `delivered` when Meta skipped it. `failed` and `skipped` are current totals. Other counters: `total`, `fed`, `accepted`, `replied`, `optedOut`, and cost per pricing category.

## Inbound messages

For each inbound message:

1. Dedupe on its wamid (`inbound_messages._id`), then insert it. Every reply is kept.
2. Open the service window (`wa:csw:{phone}`, 24 h) and update the conversation (last message, unread count).
3. **Attribute** it through `context.id` (the message it replies to) → `wa:wamid:` or the index → the delivery and its campaign. Never "the latest message to that phone". Then:
    - set `delivery.reply` (`firstAt`, `lastAt`, `count`, `lastButton`);
    - poll results count one vote per recipient, their first button: `HSETNX wa:vote:{campaignId} <deliveryId> <button>`, then `HINCRBY wa:btn:{campaignId} <button>`;
    - count `replied` once per delivery.
4. **Opt-out:** `STOP`, `UNSUBSCRIBE` and the configured keywords (exact match, any case, trimmed), or a button whose payload is in the opt-out list or whose text is an opt-out word. The number goes into `suppressions` and `wa:supp`, and `optedOut` is counted once per campaign recipient (`wa:optout:{campaignId}`), whichever of their messages created the suppression.
5. **Auto-reply,** when the campaign's rule matches (`any_button` or `any_reply`, optional per-button text). The rule is read from `wa:autoreply:{campaignId}`, which the campaign lifecycle publishes when the campaign starts, so this consumer never reads campaign documents:
    - insert a delivery with `_id = ar-<sha256(campaignDeliveryId)>`; a duplicate key means it exists already, and it is queued again only if still `pending` (a lost publish is recovered; the sender's claim prevents a second send);
    - otherwise queue it on `wa-send-p1`;
    - skip messages older than `AUTO_REPLY_MAX_AGE` (1 hour), so an outage doesn't flood people later.

## Account events

| Event | Action |
| --- | --- |
| Template `PAUSED`, `DISABLED`, `REJECTED`, `PENDING_DELETION` | Update `templates`; pause the sending campaigns using it (`wa:tpl-camps:{name:language}`, registered by the campaign lifecycle); log an error |
| Template quality or category change | Update `templates` |
| Phone number quality `FLAGGED` or `DOWNGRADE` | Pause marketing on the account (`wa:mkt-paused:{main}`): the p2 sender's gate closes, p1 continues. `UNFLAGGED` or `UPGRADE` lifts it |
| `business_capability_update` | Store the portfolio's messaging limit (`wa:limit:{portfolioId}`, and on the account) for the feeder |
| Account restricted, banned or disabled | Pause the account (`wa:acct-paused:{main}` and `wa_accounts`); log an error |

How the messaging module pauses a campaign without depending on the campaigns module: `CampaignSignals.pause()` moves the campaign's Redis state from `sending` to `paused` (the sender obeys within a second) and writes the reason to `wa:camp-pause:{campaignId}`, which the campaign sweeper records on the campaign.

Housekeeping runs on the `messaging-jobs` queue (one message type, `messaging.job.run`, naming the job): template sync every 15 minutes (it also refreshes the number's quality and limit), and a reload of the suppression mirror into Redis every 10 minutes (it only adds; removals are applied to Redis by the API).

## Campaigns

### Lifecycle

| From | Event | To |
| --- | --- | --- |
| — | create | `draft` |
| `draft` | build | `building` |
| `building` | audience written | `ready` |
| `building` | error or empty audience | `build_failed` (terminal) |
| `ready` | schedule | `scheduled` |
| `scheduled` | cancel schedule | `ready` |
| `ready`, `scheduled` | start, or the schedule is due | `sending` (after pre-flight checks) |
| `sending` | pause, or an automatic pause | `paused` (with `pauseReason`) |
| `paused` | resume | `sending` (after pre-flight checks) |
| `sending` | all fed and resolved, nothing unconfirmed | `send_complete` |
| any non-terminal | stop | `stopped` |
| `send_complete`, `stopped` | 72 h later | `closed` (terminal) |

A draft can be edited and deleted; from `building` on, a campaign can't be edited, only duplicated. Every transition is a conditional update on the current status (and `version`), so two commands never both apply.

**Pre-flight checks** on start and resume:
- the template is APPROVED, checked live against Meta;
- the endpoint matches the template's category;
- header media is younger than 29 days, or is uploaded again;
- the account isn't paused and the number's quality isn't RED;
- the audience isn't empty;
- over 100,000 recipients: the request carries the matching `confirmTotal`.

### Build

Run by the control consumer (`campaign.command.build`), resumable:

1. **Stream the audience** with cursors on the main database (`secondaryPreferred`, batches of 1,000, throttled to 5,000 documents a second), or from the CSV in the blob store. Sources: users, orders, abandoned carts, waitlist, individual users, CSV, and an earlier campaign's results (retargeting).
2. **Normalize** each phone to digits with country code (default 91). Invalid numbers count as `skipped.invalid`.
3. **Exclude** numbers on the exclusion list, suppressed numbers (`skipped.suppressed`), and, when the frequency cap is on, numbers with a marketing delivery accepted in the last N hours (`skipped.frequency`).
4. **Resolve the template parameters** (header, body, buttons) with HeliumAdmin's mapping rules: fields `name`, `phone`, `email`, `city`, CSV columns, static text; a missing value falls back to "Customer".
5. **Write** deliveries with `insertMany({ ordered: false })` in batches of 1,000, each with `seq` (from a block reserved with one `$inc`) and `dedupeKey`. A duplicate `dedupeKey` is a duplicate recipient: counted and ignored. A re-run of the build is safe.
6. Every 30 s, save `build.heartbeatAt` and `build.processed`. At the end, set `total` and the skipped counts, and mark the campaign `ready`.

### Feeder

One leader across all worker processes (`SET wa:feeder:lock <task> NX PX 15000`, renewed every 5 s). Every second it goes round-robin over the campaigns in `wa:active`:

- **Skip** a campaign when:
    - it's outside its send window (it continues when the window opens);
    - the portfolio limit is at 95% (`waitingForLimit`).
- **Target backlog** = the number's current rate × 120 s ÷ active campaigns on that number, capped by the campaign's `maxMps` × 120 s.
- **In flight** = `fed − (accepted + failed + skipped)`, from the counters.
- **If in flight is below target:** read the next deliveries `{ campaignId, status: 'pending', seq: { $gt: cursor } }` sorted by `seq`, publish them to `wa-send-p2` (`groupId = campaignId`), and add to `fed`.
- **Cursor:** saved in Redis every batch and in `campaign.feed.cursor` every 5 s. An empty read sets `feed.exhausted`.
- **After a pause,** the cursor resets to the lowest pending `seq`; already-sent deliveries are skipped by their claims.

### Pause, stop and the kill switch

| Action | Takes effect | Messages already queued | Pending deliveries |
| --- | --- | --- | --- |
| Pause | Within 2 s (1 s state cache) | Acked without sending | Stay pending; resume feeds them |
| Stop | Within 2 s | Acked and marked skipped | One `updateMany`: pending → skipped (`stopped`) |
| Kill switch (`cfg:wa:pause:global`) | Within 1 s | Not received (gate closed) | Untouched |

### Sweeper (every minute)

- Start scheduled campaigns that are due.
- Settle unknown results (above).
- Mark campaigns `send_complete` when fed, exhausted and resolved, with nothing unconfirmed.
- Close campaigns 72 h after they finished, saving a counters snapshot and removing their Redis keys.
- Re-queue builds with no heartbeat for 5 minutes.

### Test send

Up to 5 numbers, sent through `wa-send-p1` with the campaign's template and the parameters resolved for a sample recipient. Allowed from `ready` and `scheduled`. Test deliveries have `source.kind = 'test'` and don't count in the campaign.

### Stats, cost and attribution

- **Live stats** come from `wa:cnt:{campaignId}`: counts, current rate, state, `waitingForLimit`, and the estimated finish = remaining ÷ current rate. After close, from `countsSnapshot`.
- **Cost:**
    - the estimate is the total × the rate card price for the template's category (`MESSAGING_PRICE_*` config);
    - the actual cost is the count of billable deliveries per pricing category from status webhooks × the same prices.
- **Attribution:** orders in the main database whose phone matches a delivered recipient, placed within N days (default 7) after delivery. One aggregation per request, cached for 10 minutes. It reports orders, revenue, and the conversion rate.

## Failure handling

| Failure | What happens | Recovery |
| --- | --- | --- |
| A sender process dies | Its messages reappear after the visibility timeout; claims block duplicates | Automatic |
| The feeder leader dies | The lock expires within 15 s and another worker takes over | Automatic |
| The control consumer dies mid-build | The command reappears; duplicate inserts are ignored | Automatic |
| Redis unavailable | Gates close; SQS buffers the work; the webhook route is unaffected | Automatic |
| Redis data lost | Rates and counters reset | `POST /internal/v1/ops/campaigns/:id/reconcile` rebuilds counters from the database |
| MongoDB failover | Writes fail for about 30 s; messages aren't deleted, so they come back; claims block duplicates | Automatic |
| Meta outage or 5xx | Retries with backoff; the feeder's backlog stays bounded | Automatic |
| Token expired (190) | The account is paused | Rotate the token, then resume |
| Template paused by Meta | Campaigns using it are paused | Fix the template, then resume |
| Poison message | Parked in the DLQ | Fix the code, then redrive |

## Logging and privacy

- Phone numbers are masked in logs (`maskPhone`, `91******4321`).
- Message bodies, template parameters, tokens and secrets are never logged at `info` or above.
- Every log line in a consumer carries the `correlationId` (the campaign ID for campaign work) and the `deliveryId` or `campaignId`.
