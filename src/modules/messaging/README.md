# messaging module

WhatsApp messaging ([ADR-0015](../../../docs/adr/0015-whatsapp-messaging.md)): accounts, templates, the delivery ledger, the sender, webhooks, statuses, inbound messages, suppressions and the inbox. The design is in [docs/modules/messaging/](../../../docs/modules/messaging/README.md).

## Layout

| Folder | Holds |
| --- | --- |
| `whatsapp/` | Plain TypeScript for Meta, with no Nest or database: the Graph client, error classification, phone normalization, template helpers, webhook signature and splitting. A Lambda can import these |
| `webhooks/` | The webhook route and the intake service that queues each change |
| `data/` | Schemas and repositories: the only code that touches the module's collections |
| `sending/` | The sender: consumers for `wa-send-p1`/`p2`, rate limiter, result flusher, campaign counters, Lua scripts |
| `statuses/` | The status consumer: parsing, correlation (callback data, wamid map, index), batched writes and counters |
| `inbound/` | The inbound consumer: storing replies once, attribution, opt-out, poll votes, auto-replies |
| `account/` | The account consumer: template, quality, limit and account events |
| `templates/` | Template sync from Meta |
| `jobs/` | Scheduled housekeeping on `messaging-jobs` |
| `api/` | Internal routes: templates, template sync, header media, the inbox, direct messages, suppressions |
| `inbox/` | Conversations, contact pages, direct sends |

## Owns

| Kind | Name | Notes |
| --- | --- | --- |
| Config | `whatsapp` (`WA_*`) | `src/config/whatsapp.config.ts` |
| Provider | `GraphClient` | Meta's Graph API; never throws on sends, returns classified results |
| Route | `GET`, `POST /webhooks/whatsapp` | Verification challenge; signed webhooks, queued |
| Queue | `wa-status`, `wa-inbound`, `wa-account` (+ `-dlq`) | Webhook changes by kind |
| Message | `wa.webhook.status`, `wa.webhook.inbound`, `wa.webhook.account` | `{ receivedAt, wabaId, phoneNumberId?, field, value }` |
| Error | `WEBHOOK_SIGNATURE_INVALID` (401), `WEBHOOK_VERIFICATION_FAILED` (403), `WEBHOOK_NOT_QUEUED` (503) | |
| Collection | `wa_accounts`, `templates`, `media`, `deliveries`, `inbound_messages`, `conversations`, `suppressions`, `unmatched_statuses` | Migration 0002; fields and indexes in [data-model.md](../../../docs/modules/messaging/data-model.md) |
| Modules | `MessagingModule` (both processes), `MessagingApiModule` (API routes) | The worker imports only the first |
| Queue | `wa-send-p1`, `wa-send-p2` (+ `-dlq`) | Message `wa.delivery.send`; consumers `SendP1Consumer`, `SendP2Consumer` |
| Redis | `wa:rl`, `wa:rate`, `wa:pause` (per number); `wa:camp`, `wa:camp-pause`, `wa:st`, `wa:cnt` (per campaign); `wa:claim`, `wa:wamid`, `wa:unconfirmed`, `wa:uniq`, `wa:supp`, `cfg:wa-pause`, `wa:acct-paused` | Built in `messaging.keys.ts` |
| Lua | `takeTokens`, `onRateLimited`, `maybeRaiseRate`, `transition` | `sending/*.scripts.ts` |
| Consumer | `StatusConsumer` on `wa-status` | Unmatched statuses are retried 5 times, 30 s apart, then kept in `unmatched_statuses` |
| Consumer | `InboundConsumer` on `wa-inbound` | Idempotent by wamid; auto-replies go out on `wa-send-p1` |
| Redis | `wa:csw` (service window, 24 h), `wa:vote`, `wa:btn`, `wa:optout`, `wa:autoreply` (per campaign) | `wa:autoreply` is written by the campaign lifecycle (M12) |
| Consumer | `AccountConsumer` on `wa-account`; `MessagingJobsConsumer` on `messaging-jobs` | |
| Schedule | `messaging-templates-sync` (15 min), `messaging-suppressions-reload` (10 min), `messaging-unconfirmed-settle` (1 min) | Message `messaging.job.run` |
| Exports | `DeliveryLedger`, `SuppressionsService` | The campaigns module's only way to `deliveries` and the suppression mirror |
| Redis | `wa:tpl-camps:{name:language}`, `wa:mkt-paused:{account}`, `wa:limit:{portfolio}` | Template users, marketing pause, daily limit |
| Exports | `CampaignCounters`, `CampaignSignals`, `TemplatesService`, `AccountsService`, `GraphClient` | For the campaigns module |
| Error | `TEMPLATE_SYNC_FAILED` (502, retryable), `TEMPLATE_NOT_FOUND` (404), `MEDIA_NOT_FOUND` (404), `MEDIA_UNSUPPORTED` (422), `MEDIA_UPLOAD_FAILED` (502) | |
| Routes | `GET /templates`, `POST /templates/sync`, `POST /media` | Under `/internal/v1`; permissions `campaigns:read`, `messaging:ops`, `campaigns:write` |
| Routes | `GET /conversations`, `GET /contacts`, `GET /contacts/:phone`, `POST /contacts/:phone/read`, `POST /contacts/:phone/messages`, `GET`/`PUT`/`DELETE /suppressions(/:phone)`, `POST /suppressions/import` | Permissions `inbox:read`, `inbox:send`, `suppressions:write` |
| Reads | The main database's `users` | Contact profiles and search (`ContactsRepository`), read-only |
| Routes (ops) | `GET /ops/messaging`, `PUT /ops/messaging/kill-switch`, `POST /ops/queues/:queue/redrive`, `POST /ops/accounts/main/resume` | Permission `messaging:ops`; [RUNBOOK](../../../docs/RUNBOOK.md#messaging) |
| Audit | `template.sync`, `contact.message`, `suppression.add`, `suppression.remove`, `suppression.import` | |

More collections, queues, routes and error codes are added by M4–M15 and listed here as they land.

## Testing against mock-meta

`tools/mock-meta/` fakes Meta's Graph API: sends with a per-number rate limit, errors chosen by the recipient's last four digits, and signed status and inbound webhooks with duplicates and reordering. `pnpm dev` runs it on port 4010 (`WA_GRAPH_URL` in `.env.example`); integration tests start it in-process with `startMockMeta()`.

## Rules worth knowing

- **Phones** are stored and sent as `91` + 10 digits (`normalizePhone`). Log them only through `maskPhone()`.
- **Meta errors** are classified once, in `whatsapp/meta-errors.ts`. Add a new code to its table rather than handling it elsewhere.
- **Template values** fall back to "Customer" when missing, as in HeliumAdmin.
- **Delivery writes are guarded by `statusRank`**: a status applies only over a lower rank, so duplicate and out-of-order webhooks change nothing. `failed` applies below `delivered`; `skipped` only from `pending`.
- **The account** (`main`) is created from `WA_*` config at start; its pause state, quality and limit come from Meta's events and are never reset by config.
