# Messaging API

Internal routes under `/internal/v1`, called by HeliumAdmin with a service token that carries the admin user in its `act` claim ([ADR-0010](../../adr/0010-auth-and-access.md)). Request and response schemas are in the OpenAPI document at `/docs`.

- **Every mutating route** takes an `Idempotency-Key` header (`@Idempotent()`) and writes to `audit_log`.
- **Lists** use cursor paging (`after`, `limit`, default 50, maximum 200).
- **Errors** use the standard error contract; module error codes are listed in each module's README.

## Permissions and roles

HeliumAdmin has no admin roles yet, so it sends `admin` for every admin user. The other roles are ready for when it adds them.

| Permission | Allows | `admin` | `marketing` | `support` | `viewer` |
| --- | --- | --- | --- | --- | --- |
| `campaigns:read` | Campaigns, stats, recipients, replies, exports, templates | ✓ | ✓ | | ✓ |
| `campaigns:write` | Create, edit, delete drafts, duplicate, build, test send, export | ✓ | ✓ | | |
| `campaigns:send` | Start, schedule, pause, resume, stop | ✓ | ✓ | | |
| `inbox:read` | Conversations, contact timeline | ✓ | ✓ | ✓ | ✓ |
| `inbox:send` | Direct template sends and free-text replies | ✓ | ✓ | ✓ | |
| `suppressions:write` | Add, remove and import suppressions | ✓ | ✓ | ✓ | |
| `messaging:ops` | Kill switch, queue stats, DLQ redrive, reconcile, template sync | ✓ | | | |

## Campaigns

| Method and path | Permission | Does |
| --- | --- | --- |
| `GET /campaigns?status=&q=` | `campaigns:read` | List, newest first |
| `POST /campaigns` | `campaigns:write` | Create a draft (template, mapping, header media, audience, options, auto-reply validated) |
| `GET /campaigns/:id` | `campaigns:read` | Read one, with totals, skipped counts and state |
| `PATCH /campaigns/:id` | `campaigns:write` | Edit a draft |
| `DELETE /campaigns/:id` | `campaigns:write` | Delete a draft |
| `POST /campaigns/:id/duplicate` | `campaigns:write` | A new draft with the same setup |
| `POST /campaigns/:id/build` | `campaigns:write` | `draft` → `building` |
| `POST /campaigns/:id/test` | `campaigns:write` | Test send to up to 5 numbers |
| `POST /campaigns/:id/start` | `campaigns:send` | Start now (`confirmTotal` over 100,000) |
| `PUT /campaigns/:id/schedule` | `campaigns:send` | Schedule or reschedule `{ at }` |
| `DELETE /campaigns/:id/schedule` | `campaigns:send` | Cancel the schedule |
| `POST /campaigns/:id/pause`, `/resume`, `/stop` | `campaigns:send` | Commands |
| `GET /campaigns/:id/stats` | `campaigns:read` | Live counters, rate, estimated finish, cost; the UI polls every 5 s |
| `GET /campaigns/:id/deliveries?status=&reply=&q=&after=` | `campaigns:read` | Recipients table, by `seq` |
| `GET /campaigns/:id/replies` | `campaigns:read` | Button tallies and paged replies |
| `GET /campaigns/:id/attribution` | `campaigns:read` | Orders and revenue from recipients within the attribution window |
| `POST /campaigns/:id/exports`, `GET /exports/:id`, `GET /exports/:id/file` | `campaigns:read` | Async CSV export, then download |
| `POST /audiences/preview` | `campaigns:read` | Count, breakdown by source and one sample rendered with the template; the count stops at 5 s and shows "at least N" |
| `GET /audiences/options` | `campaigns:read` | Filter values (order statuses, products, delivery partners, UTM sources) |

## Templates, media and uploads

| Method and path | Permission | Does |
| --- | --- | --- |
| `GET /templates?status=` | `campaigns:read` | Synced templates |
| `POST /templates/sync` | `messaging:ops` | Sync from Meta now |
| `POST /media` | `campaigns:write` | Upload a header media file (multipart, `file`): stored and checked (type, size); it is uploaded to Meta when a campaign is tested or started |
| `POST /uploads/csv` | `campaigns:write` | Upload an audience or exclusion CSV (multipart, `file`, up to 1M rows and 100 MB): stored, columns, phone column and row count returned |

## Inbox and contacts

| Method and path | Permission | Does |
| --- | --- | --- |
| `GET /conversations?unread=&before=&limit=` | `inbox:read` | Conversation list, latest first; `unread=true` for those with unread replies |
| `GET /contacts/:phone?before=&limit=` | `inbox:read` | Profile (from the main DB), unread count, service window, suppression, and the timeline: sent and received messages merged, newest first |
| `POST /contacts/:phone/read` | `inbox:read` | Mark the conversation read |
| `POST /contacts/:phone/messages` | `inbox:send` | `{ text }` (inside the 24-hour window, else 422 `SERVICE_WINDOW_CLOSED`) or `{ template: { templateId, header?, body?, buttons?, headerMediaId? } }` (approved only, else 422 `TEMPLATE_NOT_APPROVED`); queued on `wa-send-p1`, 202 with the delivery ID |
| `GET /contacts?q=` | `inbox:read` | Search users and known numbers |

## Suppressions

| Method and path | Permission | Does |
| --- | --- | --- |
| `GET /suppressions?after=&limit=` | `inbox:read` | List, by phone |
| `PUT /suppressions/:phone` | `suppressions:write` | Add |
| `DELETE /suppressions/:phone` | `suppressions:write` | Remove |
| `POST /suppressions/import` | `suppressions:write` | Import a CSV or text file of phones (multipart, `file`); returns how many were new and the tokens that weren't phones |

## Operations

| Method and path | Permission | Does |
| --- | --- | --- |
| `GET /ops/messaging` | `messaging:ops` | Queue depth and age, DLQ depth, kill switch, number rates and pauses |
| `PUT /ops/messaging/kill-switch` | `messaging:ops` | `{ on }`: stop or allow all sending |
| `POST /ops/queues/:queue/redrive` | `messaging:ops` | Move a DLQ's messages back |
| `POST /ops/campaigns/:id/reconcile` | `messaging:ops` | Rebuild a campaign's counters from the database |
| `POST /ops/accounts/:id/resume` | `messaging:ops` | Resume a paused account |

## Webhooks (public, signed)

| Method and path | Does |
| --- | --- |
| `GET /webhooks/whatsapp` | Meta's verification challenge |
| `POST /webhooks/whatsapp` | Verify the signature, split, queue, 200; 401 `WEBHOOK_SIGNATURE_INVALID`; 503 `WEBHOOK_NOT_QUEUED` ([design.md](design.md#webhooks)) |
