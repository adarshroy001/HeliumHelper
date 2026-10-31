# WhatsApp messaging and campaigns

The backend's first business feature: sending WhatsApp campaigns and direct messages, tracking every status and reply, and the inbox. It replaces HeliumAdmin's campaign worker and webhook route.

| Doc | Answers |
| --- | --- |
| This README | What exists today, what we build, the parts and how a campaign flows |
| [design.md](design.md) | How each part works: webhooks, sending and rate limits, statuses, inbound, campaigns, failure handling |
| [data-model.md](data-model.md) | Collections and indexes, Redis keys, Lua scripts, queues |
| [api.md](api.md) | The internal HTTP API HeliumAdmin calls |

Decisions: [ADR-0015](../../adr/0015-whatsapp-messaging.md). Tasks: [PLAN.md](../../PLAN.md#phase-2--messaging-whatsapp-campaigns), M1–M18. The earlier 12-doc design in Helium-Production (`docs/architecture/messaging-platform/`) is superseded by these docs.

## What exists today

HeliumAdmin (`src/lib/whatsapp/`, `scripts/whatsapp-worker.ts`, `/api/whatsapp/*`), checked 2026-10-31:

- **Campaigns:**
    - a 6-step wizard: name, template, audience, variables, auto-reply, confirm;
    - audiences from users, orders (with filters), abandoned carts, the waitlist, individual users, a CSV (up to 10k rows, extra columns usable as variables) and an exclusion list;
    - header media (image, video, document);
    - auto-reply per campaign (text or template, on any button or any reply, with a different text per button);
    - stop, live counts, poll results (button tallies), a recipients table with filters, CSV export (up to 200k rows).
- **Contacts:** search, a timeline per phone, a direct template send, and a free-text reply inside the 24-hour window.
- **Templates:** synced from Meta by hand.
- **Storefront:** order confirmed, in transit and delivered messages, sent fire-and-forget from request handlers.

Problems found in the code:

| Problem | Effect |
| --- | --- |
| Campaign creation resolves the audience and inserts every recipient inside one request (300 s limit) | Large audiences time out; CSV rows are stored inside the campaign document |
| One worker process with an in-memory rate limit; a unique index allows one sending campaign | Can't scale out; campaigns queue one behind another |
| The worker polls MongoDB as its queue | High database CPU |
| Webhooks processed inside the request, one status at a time | Slow responses to Meta; nothing retried or kept on failure |
| `failed` ranks below `sent` | Late failures (131049, 131026) are silently dropped |
| Counts kept in memory and repaired at the end | Counts drift while a campaign runs |
| Only the latest reply kept; replies matched to "latest campaign message to that phone" | Lost replies and replies on the wrong campaign |
| No opt-out handling or suppression list | Compliance risk and quality-rating risk |
| Header media IDs treated as permanent | Meta media IDs expire after about 30 days |
| Transactional statuses have no matching record | Storefront message statuses are dropped |

## What we build

**Everything above carries over**, rebuilt on queues. On top of that:

| Feature | What it does |
| --- | --- |
| Several campaigns at once | Campaigns on the same number share its capacity fairly |
| Pause, resume, stop in seconds | Pause keeps the rest pending; stop skips them. A global kill switch stops all sending |
| Exact live counts | Updated atomically with each status; late failures counted; every reply kept and attributed by the message it replies to |
| Opt-out and suppression list | STOP keywords and opt-out buttons suppress the number at once; suppressions are honored at build and at send time; admins can add, remove and import |
| Automatic pause | When Meta pauses or disables a template, the number's quality goes red, the token fails, or the daily messaging limit is reached |
| **Scheduled send** | Start at a date and time (IST); change or cancel the schedule |
| **Send window (quiet hours)** | Send only between set hours, for example 10:00–21:00 IST; outside them the campaign waits and continues by itself |
| **Test send** | Send the real message to up to 5 numbers before starting |
| **Frequency cap** | Skip people who got a marketing message from us within the last N hours (default 24) |
| **Retargeting** | Audience from an earlier campaign's results: delivered but not read, read but no reply, replied, tapped a given button, or failed |
| **Duplicate campaign** | Copy a campaign's setup into a new draft |
| **Speed cap** | A campaign's maximum messages per second, for example to pace replies for the support team |
| **Cost estimate and actual cost** | Estimated before start from a configurable rate card; actual from Meta's pricing in status webhooks |
| **Order attribution** | Orders placed by recipients within N days (default 7) of delivery: conversions and revenue per campaign |
| **Inbox** | Every inbound message stored; a conversation list with unread counts; reply inside the 24-hour window, or send a template |
| Header media refresh | Media older than 29 days is uploaded to Meta again before a campaign starts |
| Large-audience guard | Starting a campaign over 100,000 recipients needs the count typed back |

**Later** (not in this phase):
- recurring or triggered campaigns (for example a daily abandoned-cart message);
- A/B variants;
- link click tracking;
- inbox assignment and canned replies;
- moving the storefront's order messages to the backend;
- a UI for several WhatsApp numbers (the data model already supports them);
- the raw webhook archive and the 13-month retention job.

## Parts

```text
HeliumAdmin ──service token──► API (campaigns, inbox, ops)           ──► campaign-control.fifo
Meta ──webhooks──► POST /webhooks/whatsapp (verify, split, enqueue)  ──► wa-status, wa-inbound, wa-account
worker:
  campaign control  build audiences, start, pause, resume, stop, export, test send
  feeder (1 leader) pending deliveries ──► wa-send-p2, at the allowed pace
  sender            wa-send-p1, wa-send-p2 ──► Meta (token bucket, claims, batched results)
  status            statuses ──► Lua transition + counters ──► bulkWrite
  inbound           replies, opt-outs, auto-replies (──► wa-send-p1), inbox
  account           template, quality and limit events ──► automatic pause
  messaging jobs    every minute: sweeper (schedules, completion, unconfirmed sends, stuck builds)
                    every 15 minutes: template sync
Redis: rate buckets, claims, campaign state, live counters, status ranks, suppression mirror
MongoDB messaging DB: accounts, templates, campaigns, deliveries, inbound, conversations, suppressions
MongoDB main DB (read-only): users, orders, carts, waitlist for audiences and attribution
```

## A campaign, step by step

1. **Draft:** the admin picks a template, maps variables, chooses the audience and sets options. The API validates everything and saves a `draft`.
2. **Build:** the control consumer streams the audience from the main database (a secondary) or the CSV, then:
    - normalizes phones;
    - drops duplicates, suppressed numbers and frequency-capped numbers;
    - resolves each recipient's template parameters;
    - writes `pending` deliveries in batches of 1,000.
    The campaign becomes `ready`, with counts per skip reason.
3. **Review:** the admin sees the total, the skipped counts, the estimated cost and duration, and can send a test.
4. **Start or schedule:** pre-flight checks run (template approved, media fresh, account healthy), then the campaign is `sending`, or `scheduled` until its time.
5. **Feed:** the feeder moves pending deliveries into `wa-send-p2` at the allowed pace, respecting the send window, the speed cap and the daily limit.
6. **Send:** the sender takes a token, claims the delivery, calls Meta and records the result in batches.
7. **Track:** status webhooks move each delivery up its ranks and update the live counters. Replies update the inbox, the button tallies and opt-outs, and trigger auto-replies.
8. **Finish:** the sweeper marks the campaign `send_complete` when everything is resolved, and `closed` 72 hours later, when its Redis state is removed.

## Local load test (M16)

Run on a Windows laptop against mock-meta, with `WA_MAX_MPS=500 MOCK_META_MPS=500 PORT=3100 pnpm dev` (one API, one worker, local MongoDB, Valkey and ElasticMQ in Docker). Scripts: `tools/load/campaign-load.ts [recipients]` and `tools/load/webhook-burst.ts [requests] [concurrency]`.

| Run | Result |
| --- | --- |
| 100k-recipient CSV campaign, with a 300-recipient campaign at the same time, a pause and resume mid-run, and 200 button replies | Built in 15.3 s; all 100,000 resolved in 319 s (313 msg/s sustained, 63% of the 500 msg/s cap); 0 duplicate sends; 0 sent while paused; 200 replies and button votes counted |
| 20k-recipient campaign, same mix | Last accepted after 63.6 s (315 msg/s); complete after 84.8 s (completion waits for the settle job and a sweep) |
| Webhook burst: 5,000 signed status webhooks, 50 at a time | 328 req/s, 0 failures; p50 147 ms, p95 175 ms, p99 219 ms (dev mode, with pretty logs) |

What the runs found and fixed:

- **Completion before every delivery had a result:** the in-flight count could not tell a late result from a lost one. Now a `resolved` counter counts each delivery once, and completion needs `resolved` ≥ `total`; a stopped campaign's leftovers are skipped through the counters script.
- **Rate collapse after a burst of 429s:** every request already in flight cut the rate again, down to the 10 msg/s floor, and it took about 40 minutes to recover. Now the rate is cut at most once per 2 s, and climbs back 10% every 10 s.
- **`accepted` undercounted by a few:** a fast `failed` webhook could beat the sender's batched write of `accepted`. The counters script now counts `accepted` when it arrives late (rank -1 → -3).

The send rate on this laptop is bound by the single local worker and Docker on Windows, not by the design: the target (90% of the number's rate) is to be checked on AWS in M18. The 100k run with the corrected error mix (1,000 numbers of each error kind) is still to be run.
