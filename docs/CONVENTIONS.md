# Engineering conventions

Last updated: 2026-10-29

These are the rules for writing code in `helium-backend`. Where a rule can be checked by a tool, it is, and the "Enforced by" column says how. A rule marked *planned* becomes enforced in the task named.

If the code and this document disagree, fix one of them in the same PR. Never leave them disagreeing.

## How we work

1. **Small tasks, reviewed in batches.** Tasks come from [PLAN.md](PLAN.md); each stays small. Two to four related tasks go into one branch and one PR.
2. **Before coding,** re-read the task block. If the scope is unclear or wrong, fix the plan first.
3. **One branch per batch:** `task/<first-id>-<last-id>-<short-name>`, for example `task/f11-f13-auth-mongo`, branched from `main` (or from the previous batch while it awaits merge). Each task still gets its own commits.
4. **Build** with tests alongside the code, not after it.
5. **Update docs in the same PR:** this file, `CLAUDE.md`, an ADR, a module README or a skill, whichever the change affects.
6. **Self-review** against the Definition of Done below.
7. **Push the branch and open a PR** to `main` using the template. CI runs on the PR and again on every push to it.
8. **Stop at review.** The next batch starts only after this one is approved.
9. **Commits:** small, logical commits with Conventional Commit messages, for example `feat(config): validate env at startup`. No attribution trailers. The coding agent may commit and push task branches. Merging to `main` happens through a reviewed PR.

### Definition of Done

- [ ] Each task's "Done when" criteria are met.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:int`, `pnpm test:e2e`, `pnpm build` and `pnpm test:smoke` pass locally, and the CI check `check` is green.
- [ ] New behaviour has tests, including the failure paths.
- [ ] No `any`, no unawaited promises, no `console.log`, no secrets in code or logs.
- [ ] Docs, ADRs and skills affected by the change are updated.
- [ ] `PLAN.md` status is updated.

### Repository and CI

- **Repository:** [github.com/adarshroy001/HeliumHelper](https://github.com/adarshroy001/HeliumHelper). The default branch is `main`.
- **CI** (`.github/workflows/ci.yml`) runs on every pull request and on every push to `main`. It runs these steps in order:
    1. install from the lockfile;
    2. commit message check (the pull request's commits, or the commits pushed to `main`);
    3. format, lint, typecheck;
    4. unit, integration and HTTP tests;
    5. build;
    6. smoke tests of the built app.
- **Dependabot** opens weekly update PRs for npm packages and GitHub Actions. It doesn't propose TypeScript 7 or `@types/node` majors (ADR-0014).
- **Branch protection for `main`,** set by a repo admin under GitHub → Settings → Branches (or Rulesets):
    1. Require a pull request before merging, with 1 approval, and dismiss stale approvals when new commits are pushed.
    2. Require status checks to pass: `check`. Require the branch to be up to date before merging.
    3. Require conversation resolution before merging.
    4. Block force pushes and deletions.
    5. Under General → Pull Requests, allow **squash merging only**, with the default commit message set to the pull request title.
- **One batch, one squash commit on `main`.** The PR title becomes that commit's message, so it must be a Conventional Commit, for example `feat: authentication, MongoDB and migrations (F11–F13)`. CI checks commit messages on `main`, so a bad title fails there.

## Project structure

See [ADR-0004](adr/0004-project-structure.md) for the full tree.

| Folder | What goes here | What never goes here |
| --- | --- | --- |
| `src/` root files | `main.ts` (API start), `app.module.ts` (what the API loads), `app.setup.ts` (global setup shared with HTTP tests) | Business logic; global setup only in `main.ts` |
| `src/config/` | One zod-validated config file per area | Defaults that are only safe in development, unless checked against the environment |
| `src/common/` | Code features use directly: errors, auth guards and decorators, validation, small pure utils | Business rules; connections to external systems |
| `src/infrastructure/` | Connections to the outside world: database, Redis, queues, logger, health, HTTP error responses | Business rules |
| `src/modules/<name>/` | One business feature: controllers, services, repositories, schemas, DTOs, errors, consumers | Imports of another module's internals |
| `src/lambdas/` | Small AWS Lambda handlers in plain TypeScript | Anything from `@nestjs/*` |
| `src/migrations/` | Ordered MongoDB index and data migrations (`NNNN-name.ts`) | Imports of models or business code; code that runs at app startup |
| `test/` | HTTP end-to-end tests and shared test helpers | Unit tests (those sit next to the code) |
| `deploy/` | AWS CDK | Application code |

## Configuration

- **One file per area** in `src/config/`, such as `app.config.ts`. Each holds:
    - a zod schema of that area's environment variables, with a short comment per variable;
    - a `parse…Config(env)` function that turns the validated variables into a typed object with friendly names (`port`, not `PORT`);
    - `registerAs('<area>', () => parse…Config(process.env))` and its exported type.
- **Validated at startup.** Every area is checked when the app starts. Any invalid or missing value stops startup with exit code 1, and the message lists every problem in that area.
- **`NODE_ENV` vs `APP_ENV`.**
    - `NODE_ENV` (`development` | `test` | `production`) controls how Node and libraries behave.
    - `APP_ENV` (`local` | `staging` | `production`) says which deployment is running. Staging runs with `NODE_ENV=production` and `APP_ENV=staging`.
    - Decide environment-specific behaviour on `APP_ENV`, for example `appConfig.isProduction`.
- **Production safety lives in the schema** (`superRefine`). Examples: a deployed environment must run `NODE_ENV=production`, and production refuses `debug` logging.
- **Env files.** Locally, `.env.local` then `.env` are read; real environment variables win. Tests never read env files. Vitest sets a minimal valid environment in `vitest.config.ts`.
- **Adding a variable or area:**
    1. Add it to the area's schema, or create a new area file.
    2. Register a new area in `CONFIG_AREAS` (`config.module.ts`) and `CONFIG_SCHEMAS` (`index.ts`).
    3. Add it to `.env.example` with a comment. A test fails if `.env.example` and the schemas disagree.
    4. Add tests for its validation rules.

## Logging and request context

- **Format:**
    - In deployed environments, every line is JSON on stdout: `level`, `time` (ISO), `service`, `env`, `msg`, plus fields.
    - With `NODE_ENV=development`, lines are pretty-printed.
    - With `LOG_LEVEL=silent` (the test default), nothing is printed.
- **Access log:** one line per request, `request completed`, carrying `requestId`, `req.method`, `req.path` (never the query string), `res.statusCode` and `durationMs`.
    - Levels: info for 2xx–3xx, warn for 4xx, error for 5xx.
    - Health checks aren't logged.
    - No request headers are ever logged.
- **Request ID:**
    - It comes from `resolveRequestId()` (`src/infrastructure/request-context/request-id.ts`), the only generator.
    - A safe incoming `X-Request-Id` is reused; otherwise a UUID is created.
    - The same value appears in the `X-Request-Id` response header, in every log line of the request, and in `ClsService.getId()`.
- **Writing logs in a class:**
    ```ts
    constructor(private readonly logger: PinoLogger) {
      logger.setContext(CampaignsService.name);
    }
    // ...
    this.logger.info({ campaignId, count }, 'campaign started');
    ```
    - Fields go first, then a short, constant message. Never build the message by concatenating values.
    - Don't use `@InjectPinoLogger()`: it depends on module load order.
- **Never log:**
    - tokens, secrets or passwords;
    - message bodies or template parameters;
    - raw phone numbers. Use `maskPhone()` from `src/common/utils/mask-phone.ts`.

    Known secret field names (`token`, `password`, `secret`, `authorization`, `apiKey` and similar, top level or one level deep) are replaced with `[Redacted]` automatically. That's a safety net, not permission to log them.

## Errors

Every error response has one shape ([ADR-0008](adr/0008-error-contract.md)):

```json
{ "statusCode": 404, "code": "CAMPAIGN_NOT_FOUND", "message": "Campaign not found.", "details": { "campaignId": "…" }, "requestId": "…" }
```

- `details` is present only when the error has details. `requestId` equals the `X-Request-Id` response header.
- **Throwing:** a module defines its errors in `<module>.errors.ts` by extending a common error from `src/common/errors/`, fixing the code and message:
    ```ts
    export class CampaignNotFoundError extends NotFoundError {
      constructor(campaignId: string) {
        super('CAMPAIGN_NOT_FOUND', 'Campaign not found.', { details: { campaignId } });
      }
    }
    ```
    - Common errors: `ValidationError` (400 `VALIDATION_FAILED`, `details.fields`), `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409), `RateLimitedError` (429 `RATE_LIMITED`, `details.retryAfterSeconds`).
    - The message is sent to the client as is: write it for a user, and never put internals in it.
    - Pass the original error as `cause` when wrapping one. It is logged for 5xx errors, never sent.
    - `retryable` (default `false`) tells a worker whether to retry. `RateLimitedError` is retryable.
- **What the client gets** (`src/infrastructure/http/error-response.ts`):
    - an `AppError`: its own status, code, message and details;
    - a Nest exception in the 4xx range (unknown route, invalid JSON): its status with a fixed code and message such as `NOT_FOUND` or `BAD_REQUEST`;
    - anything else: 500 `INTERNAL_ERROR` with a generic message. Nothing about the cause is revealed.
- **Logging:** a 5xx is logged once, at error level, as the request's access log line with the error and its stack attached. A 4xx is only the warn-level access line.
- **Startup failures and crashes:** a failed start, an uncaught exception or an unhandled rejection is logged as one `fatal` JSON line, then the process exits with code 1 so the platform restarts it.

## Authentication and access

- **Deny by default** ([ADR-0010](adr/0010-auth-and-access.md)). Two global guards run on every route: `AuthGuard` checks the token, `PermissionsGuard` checks the route's access decision. Every route declares one:
    ```ts
    @InternalController('campaigns')
    export class CampaignsController {
      @Get()
      @RequirePermissions('campaigns:read')
      list(@CurrentActor() actor: Actor) { ... }
    }
    ```
    - `@Public()`: no token needed (health checks). Use it rarely.
    - `@RequirePermissions('<area>:<action>', ...)`: a valid token whose user holds every listed permission.
    - On a controller, either applies to all its routes; a route can override it.
    - A route with neither is refused with 403 `ACCESS_NOT_DECLARED`, and the route-coverage test (`test/route-access.e2e-spec.ts`) fails CI.
- **Tokens:** callers send `Authorization: Bearer <JWT>`, HS256, signed with their own secret from `AUTH_CALLER_SECRETS`, with `iss` (the caller), `aud = helium-backend`, `iat` and `exp`. A token is accepted for at most 5 minutes after `iat`, with 30 seconds of clock tolerance. The admin user the service acts for travels in the signed `act` claim: `{ id, email, roles }`.
- **Errors:** 401 `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID` (the reason is logged as `token rejected`, never sent) or `AUTH_TOKEN_EXPIRED`; 403 `PERMISSION_DENIED` with `details.required`.
- **Permissions** come from the user's roles through the table in `src/common/auth/permissions.ts`. A module adds its permissions there, with the roles that grant them, when it adds routes. A token without a user has no permissions.
- **Services** receive the `Actor` from the controller as an argument, for permission and audit decisions. They never read the request.
- **Local calls:** `pnpm dev:token --roles <role,...>` prints a token signed with the local secret from `.env`.

## Database

- **Connections** ([ADR-0005](adr/0005-database.md)): `DB.main` (today's Helium database, read-only user) and `DB.messaging`, from `src/infrastructure/database/`. A module registers its models on one: `MongooseModule.forFeature([{ name: Campaign.name, schema: CampaignSchema }], DB.messaging)`, and its repository injects them with `@InjectModel(Campaign.name, DB.messaging)`.
- **Repositories** are the only code that touches Mongoose (R1). One repository per collection, in the owning module.
    - Reads use `.lean()` and return plain objects.
    - Lists use `findPage(model, filter, { limit, cursor })`: newest first by `_id`, cursor-based, never `skip`. The filter needs an index ending in `_id`, such as `{ status: 1, _id: -1 }`. Its `limit`/`cursor` come straight from `paginationQuery`.
    - Writes that must succeed or fail together use `withTransaction(connection, async (session) => ...)`, passing `session` to every operation. Only when a use case needs it; keep it short and free of calls to other services.
- **Settings that protect us:**
    - A filter on a field the schema doesn't define throws (`strictQuery: 'throw'`), instead of being dropped and matching everything.
    - `retryWrites` is off everywhere, as DocumentDB requires.
    - Indexes and collections are created from schemas only on a developer's machine (`APP_ENV=local`). Everywhere else they come from migrations (F13).
    - A database that can't be reached at startup fails the start; `/health/ready` pings both connections.
- **Locally:** `docker compose up -d` starts a MongoDB 7 replica set matching `.env.example`. Tests start their own container (`test/global-setup.ts`); integration tests take a fresh database each from `connectTestDatabase()` (`test/helpers/mongo.ts`).

## Migrations

- **Every index and data change** to the messaging database is a migration ([ADR-0005](adr/0005-database.md)). The `main` database is read-only for us and has none.
- **Adding one:** `pnpm migrate:create "add campaign indexes"` writes `src/migrations/NNNN-add-campaign-indexes.ts`. It fails until you write it, so a forgotten one can't pass a deploy:
    ```ts
    const migration: Migration = {
      async up(db) {
        await db.collection('campaigns').createIndex({ status: 1, _id: -1 });
      },
    };
    export default migration;
    ```
    - It gets the driver's `Db`, never Mongoose models, which change later while a migration must keep doing exactly what it did.
    - Up only: a mistake is fixed by a new migration. Never edit or renumber one that has been applied anywhere.
    - Make it safe to run again after a partial failure: `createIndex` already is; data changes filter on what's still to do.
    - Keep each one short (under 30 minutes, the lock's lifetime). A big backfill is a background job, not a migration.
- **Running:** `pnpm migrate` applies pending migrations in number order; `pnpm migrate:status` lists them. Each applied migration is recorded in `_migrations`.
    - The first failure stops the run; the failed migration runs again next time.
    - A lock (`_migrations_lock`) makes a second, concurrent run fail. A crashed run's lock expires after 30 minutes.
    - A pending migration numbered below one already applied (from a branch merged late) is refused: renumber it.
- **Deploying:** `node dist/migrate.js up` runs as a one-off task before the new code starts (F25). New code must work with the database both before and after its migrations.

## Redis

- **Coordination only** ([ADR-0007](adr/0007-redis.md)): locks, rate limits, idempotency keys, live counters. Never data we can't rebuild from the database or afford to lose. Every use documents what happens when Redis is down.
- **The client:** inject `Redis` (from `ioredis`) by class; `RedisModule` provides one shared client. While disconnected, commands fail at once (no offline queue), and every command times out after 2 seconds, so a caller never hangs. A Redis that can't be reached fails the start; `/health/ready` pings it.
- **Keys:** `redisKey(domain, purpose, id)` builds `domain:purpose:{id}`. The braces are the hash tag: keys that a script uses together share an `id`, so they stay in one cluster slot.
- **Atomic multi-step operations** are Lua scripts declared with `luaScript({ name, keys, lua })` next to the code that uses them, and run with `runScript(redis, script, keys, args)`. Keys are always passed in, never built inside the script.
- **Locks:** `acquireLock(redis, key, ttlMs)` returns a `Lock` or `null`; `lock.release()` deletes it only if it is still ours. Work under a lock must still be idempotent.
- **Locally:** `docker compose up -d` starts Valkey with `noeviction`. Integration tests use `connectTestRedis()` (`test/helpers/redis.ts`) and unique keys.

## HTTP

- **Route prefixes by audience** ([ADR-0010](adr/0010-auth-and-access.md)). Module controllers use `@InternalController('campaigns')` from `src/common/http/`, which serves `/internal/v1/campaigns`. Plain `@Controller` is banned in `src/modules` by lint. `/admin/v1` and `/store/v1` are reserved; their decorators are added when those audiences arrive.
- **Outside the prefixes:** `/health/live`, `/health/ready` and, except in production, `/docs`.
- **Request bodies:** JSON only, up to 1 MB (`BODY_LIMIT`). Anything larger is 413 `PAYLOAD_TOO_LARGE`; big files go through S3. `req.rawBody` (`RawBodyRequest`) keeps the exact bytes for webhook signature checks.
- **Browsers:** CORS is off unless `CORS_ORIGINS` lists origins. helmet sets security headers and removes `X-Powered-By`.
- **Health:**
    - `live` checks nothing but the process, so a database outage never makes ECS restart healthy containers.
    - `ready` runs one terminus check per dependency and returns 503 `SERVICE_UNAVAILABLE` when one fails; terminus logs the failing check. A task that adds a dependency (MongoDB, Redis, SQS) adds its check to `HealthController.ready`.
- **Shutdown:** on SIGTERM the app logs `shutting down`, stops taking connections, lets in-flight requests finish, logs `shutdown complete` and exits. Keep request handlers short (R11): ECS kills a task that hasn't stopped within its stop timeout (30 s by default).
- **Requests rejected before routing** (a body too large or not valid JSON) are logged as `request rejected`, at warn, because they never reach the access logger.

## Validation and API docs

- **Every route input has a zod schema**, attached to the parameter. The global `SchemaValidationPipe` validates it and the handler receives the parsed value:
    ```ts
    const campaignId = z.string().regex(/^[a-f\d]{24}$/, 'Must be a campaign ID.');
    const createCampaign = z.strictObject({ name: z.string().min(1).max(100), templateId: z.string() });

    @Post()
    create(@Body({ schema: createCampaign }) body: z.infer<typeof createCampaign>) { ... }

    @Get(':id')
    get(@Param('id', { schema: campaignId }) id: string) { ... }
    ```
    - Types come from the schema with `z.infer`. Never write a separate interface for the same input.
    - Schemas live next to the controller in `<module>.schemas.ts`.
- **Objects choose how to treat unknown keys.** `z.strictObject` rejects them; use it for everything we define. `z.looseObject` keeps them; use it only for third-party payloads that grow new fields, such as Meta webhooks. `z.object`, which silently drops them, is banned in `src/modules` by lint.
- **Query values are text.** Use the helpers in `src/common/validation/query.ts`: `queryInt(rules)`, `queryBoolean()`, `queryCursor()`, and `paginationQuery` (`limit` 1–100, default 20, plus `cursor`), extended with a list's own filters. Don't use `z.coerce`: it reads `''` as `0` and `'false'` as `true`.
- **Invalid input** is 400 `VALIDATION_FAILED` with `details.fields` keyed by the field's path: `name`, `items.0.phone`. An unknown key gets `Unknown field.`; a problem with the whole value is under `(root)`.
- **API docs** are generated from the same schemas, with no extra decorators, and served at `/docs` (UI) and `/docs-json` in every environment except production.

## Rules

| # | Rule | Enforced by |
| --- | --- | --- |
| R1 | **Layers:** controller → service → repository. Controllers only translate HTTP. Services hold business logic and never import HTTP types. Only repositories touch Mongoose. Between folders, `config` imports only config; `common` imports config and common; `infrastructure` imports config, common and infrastructure; `modules` add other modules (via `index.ts`); `lambdas` import common and lambdas; nothing imports the root files (`main.ts`, `app.module.ts`) | Lint `helium/module-boundaries` for the folders; review for the layers inside a module |
| R2 | **Module boundaries:** another module is used only through its `index.ts`. Cross-module side effects go through events or queues. `forwardRef` is banned | Lint `helium/module-boundaries`, `no-restricted-imports` |
| R3 | **File size:** 400 lines or fewer per file, not counting blank lines and comments. A growing service is split by use case | Lint `max-lines` |
| R4 | **Types:** strict TypeScript. No `any`, no non-null `!`, no unawaited promises, `===` only. An exception needs an `eslint-disable-next-line` with a reason; unused disables fail lint | tsconfig + typescript-eslint `strictTypeChecked` |
| R5 | **Validation:** every input is validated with zod: body, query, params, env, queue messages, webhook payloads. Unknown keys are rejected (`z.strictObject`), except in third-party payloads (`z.looseObject`). See [Validation and API docs](#validation-and-api-docs) | Global validation pipe (tested); lint bans `z.object` in `src/modules`; review |
| R6 | **Errors:** throw an `AppError` subclass from the module's `*.errors.ts`. Never throw `HttpException` or a bare `Error` from services. Error codes are `SCREAMING_SNAKE_CASE`, unique, and never reused. See [Errors](#errors) | Lint in `src/modules` (no `*Exception` imports from `@nestjs/common`, no `throw new Error`); review for codes |
| R7 | **Access:** every route declares `@Public()` or `@RequirePermissions(...)`. Routes are denied by default. See [Authentication and access](#authentication-and-access) | Global guards; route-coverage test |
| R8 | **Data access:** queries are scoped and indexed. Lists use cursor pagination, never `skip`. Hot paths use `bulkWrite` and `lean()`. Transactions only when a use case needs them, kept short. See [Database](#database) | `findPage` and `withTransaction` helpers; `strictQuery: 'throw'`; review |
| R9 | **Database writes:** the `main` database is read-only from this backend unless an ADR grants a module write access to specific collections | Database user permissions (*planned, F24*) |
| R10 | **Idempotency:** queue consumers are idempotent by a natural key. Mutating admin endpoints accept `Idempotency-Key` | Review; F15 interceptor |
| R11 | **Async work:** nothing slow or external runs inside an HTTP request that the caller waits on. Put it on a queue | Review |
| R12 | **Config:** inject the typed config of an area (`@Inject(appConfig.KEY) private readonly app: AppConfig`). Never read `process.env` outside `src/config`, and don't use `ConfigService.get('…')` string keys in feature code. See [Configuration](#configuration) | Lint `no-restricted-properties` (`process.env` outside `src/config` and tests) |
| R13 | **Logging:** use the injected `PinoLogger` with structured fields. Phone numbers are masked with `maskPhone()`; tokens, secrets and message bodies are never logged. See [Logging and request context](#logging-and-request-context) | Redaction of known secret fields, header-free and query-free access logs (tested); review |
| R14 | **Tests:** unit tests for business rules (`*.spec.ts` next to the code), integration tests against real Mongo, Redis and SQS containers (`*.int-spec.ts` next to the code), HTTP tests through the real app via `createTestApp()` (`test/*.e2e-spec.ts`), and smoke tests that run the built app as a process for signals and startup (`test/smoke/*.smoke-spec.ts`). Tests use the same strict lint rules as app code | `pnpm test`, `test:int`, `test:e2e`, `test:smoke`; CI |
| R15 | **Dependencies:** add a library only with a reason in the PR description. Prefer what is already in use. Versions are pinned exactly (`savePrefix: ''`). Dependency install scripts are denied unless listed in `allowBuilds` in `pnpm-workspace.yaml` | Review; pnpm settings |
| R16 | **ESM imports:** relative imports end in `.js`, even from `.ts` files (`./app.module.js`). Type-only imports use `import type`, except in files with decorators, where the lint rule stands down because NestJS injection needs real imports | TypeScript `nodenext` (compile error); lint `consistent-type-imports` |
| R17 | **Style and commits:** Prettier formats code (Markdown is hand-formatted). Commit messages follow Conventional Commits. Both are checked on commit by husky (lint-staged and commitlint) and again in CI | `pnpm format:check`, git hooks |

**Lint rules live in two places:** `eslint.config.js`, and the local plugin `eslint/helium-plugin.js` for the folder and module boundaries. Every rule is an error; there are no warnings.

## Naming

| Thing | Convention | Example |
| --- | --- | --- |
| Files | `kebab-case` with a role suffix | `campaigns.service.ts`, `campaign.schema.ts`, `send.consumer.ts` |
| Classes | `PascalCase` with a role suffix | `CampaignsService`, `SendConsumer` |
| Error codes | `SCREAMING_SNAKE_CASE`, prefixed by module where useful | `CAMPAIGN_NOT_FOUND` |
| Queues | `{env}-{domain}-{purpose}`, `.fifo` when FIFO | `prod-wa-send-p2` |
| Message types | `{domain}.{noun}.{verb}` | `wa.delivery.send` |
| Routes | Plural nouns, audience prefix, version | `/internal/v1/campaigns/:id/start` |
| Mongo collections | `snake_case`, plural | `deliveries`, `inbound_messages` |

## Change log

| Date | Change |
| --- | --- |
| 2026-10-28 | First version (T0) |
| 2026-10-28 | R15 now requires exact versions and an allowlist for install scripts; new R16 on ESM imports (F2) |
| 2026-10-28 | R1–R4 and R16 enforced by lint, with folder import rules spelled out in R1; new R17 on style and commits (F3) |
| 2026-10-28 | R14 gives test file locations and `createTestApp()`; `app.setup.ts` added to the structure table (F4) |
| 2026-10-29 | CI, Dependabot and branch protection documented; the agent may commit and push task branches (F5) |
| 2026-10-29 | New Configuration section; R12 enforced by lint (F6) |
| 2026-10-29 | New Logging and request context section; R13 detailed (F7) |
| 2026-10-29 | New Errors section; R6 enforced by lint (F8) |
| 2026-10-29 | New Validation and API docs section; R5 enforced by the pipe and lint (F9) |
| 2026-10-29 | New HTTP section; smoke tests added to R14 (F10) |
| 2026-10-29 | Tasks are reviewed in batches of two to four, one branch and PR per batch |
| 2026-10-29 | New Authentication and access section; R7 enforced (F11) |
| 2026-10-29 | New Database section; R8 helpers (F12) |
| 2026-10-29 | New Migrations section; migrations live in `src/migrations/` (F13) |
| 2026-10-29 | New Redis section (F14) |
