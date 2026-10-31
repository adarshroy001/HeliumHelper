# campaigns module

WhatsApp campaigns ([ADR-0015](../../../docs/adr/0015-whatsapp-messaging.md)): drafts, audiences, the build, the feeder, the lifecycle, stats and exports. The design is in [docs/modules/messaging/](../../../docs/modules/messaging/README.md). It uses the messaging module only through its exports (`TemplatesService`, `MediaService`, `CampaignCounters`, `CampaignSignals`, the send message).

## Owns

| Kind | Name | Notes |
| --- | --- | --- |
| Collection | `campaigns` | Migration 0003; indexes `status_id`, `status_schedule_at` |
| Collection | `uploads` | Audience and exclusion CSVs; the file is in the blob store (`uploads/…`) |
| Routes | `GET`/`POST /campaigns`, `GET`/`PATCH`/`DELETE /campaigns/:id`, `POST /campaigns/:id/duplicate`, `POST /campaigns/:id/build`, `POST /uploads/csv`, `POST /audiences/preview`, `GET /audiences/options` | Under `/internal/v1`; [api.md](../../../docs/modules/messaging/api.md) |
| Queue | `campaign-control` (+ `-dlq`) | Message `campaign.command.run`; consumer `CampaignControlConsumer` |
| Reads | The main database's `users`, `orders`, `abandonedcarts`, `newwaitlists` | Read-only, secondary preferred, at most 5,000 documents a second (`AudienceSourcesRepository`) |
| Permissions | `campaigns:read`, `campaigns:write` | Roles in `src/common/auth/permissions.ts` |
| Errors | `CAMPAIGN_NOT_FOUND` (404), `CAMPAIGN_STATE_CONFLICT` (409), `CAMPAIGN_INVALID` (422, `details.problems`), `UPLOAD_NOT_FOUND` (404), `CSV_INVALID` (422) | |
| Audit | `campaign.create`, `campaign.update`, `campaign.delete`, `campaign.build` | In the same transaction as the change |
| Modules | `CampaignsModule` (both processes), `CampaignsApiModule` (API routes) | |

## Rules worth knowing

- **Only drafts can be edited or deleted.** Every change is conditional on the status and `version`, so two admins can't overwrite each other; the loser gets 409.
- **A draft is validated as a whole** on create and on every edit, and every problem is returned at once (`details.problems`), so the composer can show them together.
- **The template is a snapshot** taken at create: later edits to the template on Meta don't change a campaign. Duplicating checks the setup again against today's templates.
- **CSV audiences**: up to 1,000,000 rows and 50 named columns, with a phone column (`phone`, `mobile`, `whatsapp`, …). Extra columns are variables: `{ source: 'field', value: 'csv:<column>' }`.
- **The build** (`AudienceBuilder`) streams every source in HeliumAdmin's priority order and writes pending deliveries through the messaging module's `DeliveryLedger`; the ledger keeps one per phone. A build that finds nobody left ends `build_failed` with `build.error`.
- **The preview** counts each source (5 s at most each; `null` when a count runs out of time) and renders one sample. Its total is an upper bound; the build gives the exact one.
- **Header media** is stored by `POST /media` (messaging module); it is uploaded to Meta when the campaign is tested or started, and again near Meta's 30-day expiry.
