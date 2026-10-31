# messaging module

WhatsApp messaging ([ADR-0015](../../../docs/adr/0015-whatsapp-messaging.md)): accounts, templates, the delivery ledger, the sender, webhooks, statuses, inbound messages, suppressions and the inbox. The design is in [docs/modules/messaging/](../../../docs/modules/messaging/README.md).

## Layout

| Folder | Holds |
| --- | --- |
| `whatsapp/` | Plain TypeScript for Meta, with no Nest or database: the Graph client, error classification, phone normalization, template helpers. A Lambda can import these |

## Owns

| Kind | Name | Notes |
| --- | --- | --- |
| Config | `whatsapp` (`WA_*`) | `src/config/whatsapp.config.ts` |
| Provider | `GraphClient` | Meta's Graph API; never throws on sends, returns classified results |

Collections, queues, routes and error codes are added by M3–M15 and listed here as they land.

## Rules worth knowing

- **Phones** are stored and sent as `91` + 10 digits (`normalizePhone`). Log them only through `maskPhone()`.
- **Meta errors** are classified once, in `whatsapp/meta-errors.ts`. Add a new code to its table rather than handling it elsewhere.
- **Template values** fall back to "Customer" when missing, as in HeliumAdmin.
