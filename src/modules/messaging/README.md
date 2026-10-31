# messaging module

WhatsApp messaging ([ADR-0015](../../../docs/adr/0015-whatsapp-messaging.md)): accounts, templates, the delivery ledger, the sender, webhooks, statuses, inbound messages, suppressions and the inbox. The design is in [docs/modules/messaging/](../../../docs/modules/messaging/README.md).

## Layout

| Folder | Holds |
| --- | --- |
| `whatsapp/` | Plain TypeScript for Meta, with no Nest or database: the Graph client, error classification, phone normalization, template helpers, webhook signature and splitting. A Lambda can import these |
| `webhooks/` | The webhook route and the intake service that queues each change |

## Owns

| Kind | Name | Notes |
| --- | --- | --- |
| Config | `whatsapp` (`WA_*`) | `src/config/whatsapp.config.ts` |
| Provider | `GraphClient` | Meta's Graph API; never throws on sends, returns classified results |
| Route | `GET`, `POST /webhooks/whatsapp` | Verification challenge; signed webhooks, queued |
| Queue | `wa-status`, `wa-inbound`, `wa-account` (+ `-dlq`) | Webhook changes by kind |
| Message | `wa.webhook.status`, `wa.webhook.inbound`, `wa.webhook.account` | `{ receivedAt, wabaId, phoneNumberId?, field, value }` |
| Error | `WEBHOOK_SIGNATURE_INVALID` (401), `WEBHOOK_VERIFICATION_FAILED` (403), `WEBHOOK_NOT_QUEUED` (503) | |

More collections, queues, routes and error codes are added by M4–M15 and listed here as they land.

## Testing against mock-meta

`tools/mock-meta/` fakes Meta's Graph API: sends with a per-number rate limit, errors chosen by the recipient's last four digits, and signed status and inbound webhooks with duplicates and reordering. `pnpm dev` runs it on port 4010 (`WA_GRAPH_URL` in `.env.example`); integration tests start it in-process with `startMockMeta()`.

## Rules worth knowing

- **Phones** are stored and sent as `91` + 10 digits (`normalizePhone`). Log them only through `maskPhone()`.
- **Meta errors** are classified once, in `whatsapp/meta-errors.ts`. Add a new code to its table rather than handling it elsewhere.
- **Template values** fall back to "Customer" when missing, as in HeliumAdmin.
