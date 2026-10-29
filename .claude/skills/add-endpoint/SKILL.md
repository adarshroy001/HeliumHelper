---
name: add-endpoint
description: Add an HTTP route to a helium-backend module - controller, zod schema, access decision, service, errors, idempotency, audit and HTTP test. Use for any new /internal/v1 route.
---

# Add an endpoint

## Steps

1. **Schema** in `<name>.schemas.ts`; the type comes from it:
   ```ts
   export const createCampaign = z.strictObject({ name: z.string().min(1).max(100) });
   export type CreateCampaign = z.infer<typeof createCampaign>;
   ```
   Query strings: `queryInt()`, `queryBoolean()`, `paginationQuery` from `src/common/validation`.
2. **Controller**, translating HTTP only:
   ```ts
   @InternalController('campaigns')            // serves /internal/v1/campaigns
   export class CampaignsController {
     constructor(private readonly campaigns: CampaignsService) {}

     @Post()
     @RequirePermissions('campaigns:write')    // or @Public(), rarely
     @Idempotent()                             // mutating routes callers may retry
     create(@CurrentActor() actor: Actor, @Body({ schema: createCampaign }) body: CreateCampaign) {
       return this.campaigns.create(actor, body);
     }
   }
   ```
   Path params: `@Param('id', { schema: campaignId })`. Lists return `findPage()` results.
3. **Permission**: add `'campaigns:write'` to the roles that grant it in `src/common/auth/permissions.ts`.
4. **Service**: business rules; takes the `Actor`; throws errors from `<name>.errors.ts`:
   ```ts
   export class CampaignNotFoundError extends NotFoundError {
     constructor(id: string) { super('CAMPAIGN_NOT_FOUND', 'Campaign not found.', { details: { id } }); }
   }
   ```
   State changes for an admin: `withTransaction()` + `AuditService.record(..., session)`. Slow or external work: publish to a queue instead.
5. **Repository**: the only class that uses the model; `.lean()` reads.
6. **Error codes**: list new codes in the module README.
7. **HTTP test** in `test/<name>.e2e-spec.ts` (skill `write-tests`): the happy path, validation, a missing permission, and each error.
8. Check `/docs` shows the route; run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`.

## Never

- Read `req` in a service, or return Mongoose documents from a controller.
- Write a separate interface for the body: use `z.infer`.
- Leave a route without `@Public()` or `@RequirePermissions()` (the coverage test fails).
- Call another service over HTTP or do slow work inside the request (R11).
- Put internals, secrets or raw phone numbers in error messages or logs.
