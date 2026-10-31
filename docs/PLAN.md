# Delivery plan

Last updated: 2026-10-31

We build `helium-backend` one small task at a time, one commit (or a few) per task. Phase 1 went through a review stop per batch of tasks. Phase 2 is built end to end on one branch and raised in as few PRs as possible; AWS deployment is deferred, so everything is verified locally.

- **Phase 1 (foundation)** builds the base every feature relies on.
- **Phase 2 (messaging)** builds the WhatsApp campaign system on top of it.

The workflow and the Definition of Done for every task are in [CONVENTIONS.md](CONVENTIONS.md#how-we-work). The decisions behind this plan are in [adr/](adr/).

## Status

| ID | Task | Depends on | Status |
| --- | --- | --- | --- |
| T0 | Plan, decisions and docs skeleton | — | Done |
| F1 | Toolchain check and version lock | T0 | Done |
| F2 | Project scaffold | F1 | Done |
| F3 | Lint, format and git hooks | F2 | Done |
| F4 | Test setup | F2 | Done |
| F5 | CI pipeline and repo hygiene | F3, F4 | Done |
| F6 | Config | F5 | Done |
| F7 | Logging and request context | F6 | Done |
| F8 | Error handling | F7 | Done |
| F9 | Validation and API docs | F8 | Done |
| F10 | HTTP setup and health | F9 | Done |
| F11 | Authentication and access control | F10 | Done |
| F12 | MongoDB connections and repositories | F10 | Done |
| F13 | Migrations | F12 | Done |
| F14 | Redis | F10 | Done |
| F15 | Rate limiting and idempotency | F11, F14 | Done |
| F16 | Queue publisher | F10 | Done |
| F17 | Queue consumer runner and worker process | F16 | Done |
| F18 | Scheduled jobs | F17 | Done |
| F19 | Audit log | F12 | Done |
| F20 | Local development polish | F17 | Done |
| F21 | Skills and conventions review | F20 | Done |
| F22 | Docker image | F17 | Done |
| F23 | AWS foundation (CDK) | F22 | Done |
| F24 | AWS data and queues | F23 | Done |
| F25 | AWS services and staging deploy | F24 | Code done; staging deploy deferred (needs AWS) |
| F26 | Deploy pipeline and runbook | F25 | Code done; first deploy and rollback rehearsal deferred (needs AWS) |
| M1 | Messaging design and plan | F26 | Done |
| M2 | WhatsApp building blocks | M1 | Done |
| M3 | Webhook intake | M2 | Done |
| M4 | mock-meta | M2 | Done |
| M5 | Messaging data model | M1 | Done |
| M6 | Sender | M2, M5 | Done |
| M7 | Status consumer | M5, M6 | Done |
| M8 | Inbound consumer and auto-reply | M7 | Done |
| M9 | Account events and template sync | M5 | Done |
| M10 | Campaign API and uploads | M5, M9 | Done |
| M11 | Audience build | M10 | Not started |
| M12 | Lifecycle, feeder and sweeper | M6, M11 | Not started |
| M13 | Campaign reads, export and attribution | M12 | Not started |
| M14 | Inbox, direct messages and suppressions | M8 | Not started |
| M15 | Messaging operations | M12 | Not started |
| M16 | End-to-end and load test (local) | M13–M15 | Not started |
| M17 | HeliumAdmin integration | M16 | Not started |
| M18 | Rollout | M17, F25, F26 | Not started (needs AWS) |

Where the dependencies allow, tasks may be done in a different order. The order above is the default.

## Phase 0

### T0 · Plan, decisions and docs skeleton

- **Goal:** agree on how we build before writing code.
- **Deliverables:** `README.md`, `CLAUDE.md`, `docs/PLAN.md`, `docs/CONVENTIONS.md`, `docs/adr/0001–0013`, `.gitignore`.
- **Done when:** you have reviewed and approved the plan, the conventions and the ADRs.

## Phase 1 · Foundation

Every foundation task follows the same rules:

- **Tests:** each task adds its own.
- **Docs:** each task updates `CONVENTIONS.md` and `CLAUDE.md` when it adds a rule or command.
- **No business logic.** Nothing in this phase is specific to messaging.

### F1 · Toolchain check and version lock

- **Goal:** prove that NestJS 12, released August 2026, works with every library we depend on before we commit to it.
- **Scope:**
    - In a throwaway folder outside the repo, build a tiny app with NestJS 12, `@nestjs/mongoose`, `nestjs-pino`, `nestjs-cls`, zod through Standard Schema on `@Body`/`@Query`, `@nestjs/swagger`, `@nestjs/terminus`, `@nestjs/throttler` and Vitest.
    - Decide between an ESM and a CommonJS project.
    - Note the exact versions that work together.
- **Out of scope:** any code in the repo.
- **Deliverables:**
    - ADR-0014 "Toolchain versions", with the version table, ESM or CJS, and anything that failed.
    - If NestJS 12 fails on something we need, the ADR records NestJS 11 as the choice and why.
- **Done when:** the ADR is approved.

### F2 · Project scaffold

- **Goal:** an empty but correct NestJS project in the agreed folder structure ([ADR-0004](adr/0004-project-structure.md)).
- **Scope:**
    - `package.json` with pnpm and Node 24 (`.nvmrc`, `engines`), plus `tsconfig.json` and `tsconfig.build.json` in strict mode.
    - Nest CLI config, `.editorconfig`, `.env.example`.
    - The folder skeleton `src/{config,common,infrastructure,modules,lambdas}`.
    - A minimal `main.ts` and `app.module.ts`.
    - Scripts: `dev`, `build`, `start`, `typecheck`.
- **Out of scope:** lint, tests and CI (F3–F5); any feature.
- **Done when:** `pnpm install && pnpm build && pnpm start` serves a request on a clean clone, and `pnpm typecheck` passes.

### F3 · Lint, format and git hooks

- **Goal:** code style and the hard rules are checked automatically, so nobody argues about them in review.
- **Scope:**
    - ESLint with typescript-eslint `strictTypeChecked`. Every rule is an error, never a warning.
    - Prettier.
    - Rules:
        - `no-explicit-any`;
        - `no-floating-promises`;
        - `max-lines` (400 per file);
        - ban `forwardRef`;
        - module boundaries (another module may be imported only through its `index.ts`);
        - `src/lambdas` may not import `@nestjs/*`.
    - husky and lint-staged on commit; commitlint with Conventional Commits.
- **Done when:**
    - `pnpm lint` and `pnpm format:check` pass;
    - each custom rule has a deliberately bad sample that the lint run rejects (the sample is not committed);
    - the hooks run on commit.

### F4 · Test setup

- **Goal:** unit, integration and HTTP tests have a home and run fast.
- **Scope:**
    - Vitest 5. It handles decorator metadata natively, so no SWC plugin ([ADR-0014](adr/0014-toolchain-versions.md)).
    - Three configs, matching [ADR-0012](adr/0012-testing.md):
        - `test` (unit, `src/**/*.spec.ts`);
        - `test:int` (integration, `src/**/*.int-spec.ts`, containers wired in F12);
        - `test:e2e` (`test/**/*.e2e-spec.ts`).
    - Coverage reports.
    - A `test/helpers/` folder with an app factory for HTTP tests.
    - One sample unit test and one HTTP test against `GET /health/live`.
    - Unit tests for the local lint rule `eslint/helium-plugin.js` using ESLint's `RuleTester`: every allowed and refused import from R1–R2. F3 verified it only by hand.
- **Done when:** `pnpm test`, `pnpm test:int` (no tests yet, passes empty), `pnpm test:e2e` and `pnpm test:cov` pass.

### F5 · CI pipeline and repo hygiene

- **Goal:** nothing reaches `main` without passing every check.
- **Scope:**
    - A GitHub Actions workflow on pull requests and `main`: install (cached), `lint`, `format:check`, `typecheck`, `test`, `test:int`, `test:e2e`, `build`.
    - A PR template containing the Definition of Done checklist.
    - `CODEOWNERS`.
    - Dependabot for npm and GitHub Actions.
    - Branch protection steps documented (you apply them in GitHub).
- **Done when:** a PR with a lint error fails CI, and a clean PR passes.

### F6 · Config

- **Goal:** typed configuration that refuses to start when anything is wrong.
- **Scope:**
    - One zod-validated file per area, starting with `app.config.ts` (env, port, log level, app name).
    - A typed accessor that keeps `ConfigService` strings out of feature code.
    - Production-safety checks, such as refusing dev defaults in production.
    - A test that keeps `.env.example` and the schemas in sync.
- **Done when:** a missing or invalid variable stops startup with a clear message, and tests cover it.

### F7 · Logging and request context

- **Goal:** every log line is JSON, safe to keep, and traceable to one request.
- **Scope:**
    - `nestjs-pino`, with pretty output in development only.
    - Redaction of auth headers, cookies and tokens.
    - A `maskPhone()` utility.
    - `nestjs-cls` carrying `requestId`, which is taken from `X-Request-Id` or generated, echoed in the response, and included in every log line.
    - **One** ID generator feeds both `pino-http` and `nestjs-cls`. The F1 spike showed that they each generate their own by default ([ADR-0014](adr/0014-toolchain-versions.md)).
    - A trimmed access log: method, url, status and duration, with no request headers.
- **Done when:** a test request without `X-Request-Id` produces one access log line whose `requestId` matches the one in the response header and in the request context, and secrets are redacted (tested).

### F8 · Error handling

- **Goal:** one error contract for the whole backend ([ADR-0008](adr/0008-error-contract.md)).
- **Scope:**
    - `AppError` base with `code`, `status`, `message`, `details`, `retryable` and `cause`.
    - Common errors: `NotFoundError`, `ConflictError`, `ForbiddenError`, `UnauthorizedError`, `ValidationError`, `RateLimitedError`.
    - A global exception filter producing `{ statusCode, code, message, details?, requestId }`. Only 5xx errors are logged at error level, and unknown errors never leak their internals.
    - Nest's built-in exceptions are mapped to the same shape.
    - Startup failures exit with code 1 and are logged **once**. Today Nest's `ExceptionHandler` and our bootstrap handler both log an invalid config (seen in F6).
    - Process-level handlers for `unhandledRejection` and `uncaughtException`: log, then exit.
- **Done when:** HTTP tests cover a domain error, an unknown error, Nest's own 404, and validation and rate-limit shapes.

### F9 · Validation and API docs

- **Goal:** every input is validated with zod, and the API documents itself.
- **Scope:**
    - NestJS 12's `StandardSchemaValidationPipe`, registered globally. Its `exceptionFactory` maps issues to the F8 `VALIDATION_FAILED` error with `details.fields`. Swagger uses `standardSchemaConverter` with `z.toJSONSchema` ([ADR-0014](adr/0014-toolchain-versions.md)).
    - Strict objects: unknown keys are rejected with 400 `VALIDATION_FAILED` and per-field details.
    - Helpers for query coercion (numbers, booleans, cursors).
    - Swagger generated from the zod schemas, served at `/docs` outside production only.
- **Done when:** tests cover an unknown key, a wrong type and a coerced query, and `/docs` renders locally.

### F10 · HTTP setup and health

- **Goal:** a hardened, versioned HTTP layer and health checks.
- **Scope:**
    - helmet, CORS from config, a body size limit, and raw body kept for future signature checks.
    - Route prefixes by audience ([ADR-0010](adr/0010-auth-and-access.md)): `/internal/v1` now; `/admin/v1` and `/store/v1` reserved.
    - `enableShutdownHooks()` and graceful shutdown.
    - `@nestjs/terminus` serving `/health/live` (the process is up) and `/health/ready` (dependencies reachable; it gains checks in F12, F14 and F16).
- **Done when:** HTTP tests cover the health endpoints, the prefixes and the body limit, and a SIGTERM shuts down cleanly (tested).

### F11 · Authentication and access control

- **Goal:** deny by default, with HeliumAdmin calling as a trusted service.
- **Scope:**
    - **An `Actor` model:** caller service plus an optional user, with `id`, `email` and `roles`.
    - **A global `AuthGuard`** that verifies a short-lived service JWT (HS256, `iss`/`aud`/`exp`, the user carried in the `act` claim).
    - **Decorators:** `@Public()`, `@RequirePermissions()`, `@CurrentActor()`.
    - **A global `PermissionsGuard`:** a route with no access decorator is refused.
    - **A route-coverage test:** it scans every route and fails if one has no access decorator.
    - **A helper script** that issues a dev token.
- **Out of scope:** customer and admin-user login (added when a task needs it).
- **Done when:** tests cover a missing token, a bad signature, an expired token, a wrong audience, a missing permission and an allowed call, and the coverage test fails on an undecorated route.

### F12 · MongoDB connections and repositories

- **Goal:** safe, named database connections and one repository pattern ([ADR-0005](adr/0005-database.md)).
- **Scope:**
    - **Named connections from config:** `main` (today's Helium DB, read-only user) and `messaging`. TLS with the DocumentDB CA bundle.
    - **Pool settings:** size and timeouts, including `serverSelectionTimeoutMS` and `maxIdleTimeMS`.
    - **Mongoose settings:** `autoIndex` off in production, `strictQuery`.
    - **Health:** a readiness check per connection.
    - **Repository conventions:** a base helper for cursor pagination and `lean()` reads, plus a `withTransaction()` helper used only when a use case needs it.
    - **Local and test setup:** `docker-compose.yml` with a MongoDB replica set; a testcontainers helper for integration tests.
- **Done when:**
    - integration tests run against real Mongo: connect, repository read and write, pagination, a transaction commit and rollback;
    - readiness turns red when Mongo is down.

### F13 · Migrations

- **Goal:** indexes and data changes are versioned, reviewed and applied once.
- **Scope:**
    - A `src/migrations/` folder holding ordered, up-only scripts (moved from a top-level folder; see ADR-0004).
    - A runner that records applied migrations in `_migrations` and takes a lock so two runs can't race.
    - Commands: `pnpm migrate`, `pnpm migrate:status`, `pnpm migrate:create <name>`.
    - Documented as a deploy step that runs before the new code starts.
- **Done when:** integration tests show a migration applies once, a second run is a no-op, and a failed migration stops the run.

### F14 · Redis

- **Goal:** one shared Redis (Valkey) client for coordination ([ADR-0007](adr/0007-redis.md)).
- **Scope:**
    - **Client:** an ioredis module with TLS and auth from config, and a readiness check.
    - **Key naming:** a helper with hash tags.
    - **Lua scripts:** a registry that loads them with `defineCommand` and parameterized keys.
    - **Distributed lock:** `SET NX PX` plus a safe release.
    - **Local and test setup:** Valkey added to docker-compose; a testcontainers helper.
- **Done when:** integration tests cover a Lua script, lock contention between two clients, and readiness turning red when Redis is down.

### F15 · Rate limiting and idempotency

- **Goal:** limits and retries are safe across many API instances.
- **Scope:**
    - **Throttling:** `@nestjs/throttler` with Redis storage, a default limit per audience prefix, and per-route overrides.
    - **Idempotency:** an `@Idempotent()` decorator and interceptor using the `Idempotency-Key` header:
        - the first response is stored in Redis for 24 h;
        - a retry with the same key and body returns the stored response;
        - the same key with a different body returns 422;
        - a request still in progress returns 409.
- **Done when:** tests cover each idempotency case, and a 429 is returned in the standard error shape.

### F16 · Queue publisher

- **Goal:** any module can put work on a queue the same way ([ADR-0006](adr/0006-async-work.md)).
- **Scope:**
    - An SQS client module that reads the endpoint from config (ElasticMQ locally).
    - The message envelope (`v`, `id`, `type`, `ts`, `producer`, `correlationId`, `data`), defined with zod.
    - `publish()` and `publishBatch()`, which chunk into 10s and retry failed entries.
    - Optional `MessageGroupId` for FIFO and fair queues.
    - `requestId` carried into `correlationId`.
    - ElasticMQ added to docker-compose, with a queue config file.
- **Done when:** integration tests publish to ElasticMQ, cover batch chunking, and confirm an invalid envelope is rejected before sending.

### F17 · Queue consumer runner and worker process

- **Goal:** background work runs in a separate process with retries, a DLQ and a clean shutdown.
- **Scope:**
    - **`@Consumer({ queue, concurrency, batchSize, visibility })` on a handler class,** found automatically by Nest.
    - **The runner:**
        - long polling, then the outcomes `ack`, `retry(delay)`, `park(reason)` and `hold(delay)`;
        - deletes only the messages that succeeded;
        - a visibility heartbeat for long handlers;
        - an optional `gate()` before each receive.
    - **Error mapping:** `AppError.retryable` decides between retry and park.
    - **Context:** a `nestjs-cls` context per message, carrying `correlationId`.
    - **The worker process:**
        - `worker.ts` and `worker.module.ts`;
        - `WORKER_QUEUES` chooses which consumers run;
        - a health endpoint on its own port;
        - on SIGTERM it stops receiving, finishes in-flight work and exits.
- **Done when:** integration tests on ElasticMQ cover success, retry with backoff, park to the DLQ, a crash mid-message (the message comes back), and a graceful shutdown that loses nothing.

### F18 · Scheduled jobs

- **Goal:** crons without a crontab ([ADR-0006](adr/0006-async-work.md)).
- **Scope:**
    - A typed schedule registry in code: name, cron expression, time zone, target queue, message.
    - In AWS, F24 creates one EventBridge Scheduler schedule per entry.
    - Locally, a dev-only timer in the worker publishes the same messages.
    - Handlers are normal consumers.
- **Done when:** a sample schedule fires locally, and a test proves the registry and the CDK input match.

### F19 · Audit log

- **Goal:** every state-changing admin action is recorded.
- **Scope:**
    - An `audit_log` collection in the `messaging` DB for now, with actor, action, entity, before/after (changed fields only), `requestId` and time.
    - An `AuditService.record()`, called explicitly by services.
    - An index and a retention note.
- **Done when:** integration tests show a record written with actor and request ID, and a failed audit write fails the action. Audit is part of the change, not best-effort.

### F20 · Local development polish

- **Goal:** a new developer runs everything in 15 minutes.
- **Scope:**
    - `pnpm dev` runs the API and worker together, with docker-compose up.
    - `pnpm seed` loads sample data.
    - A Getting Started section in the README covering prerequisites, first run and common problems.
- **Done when:** someone follows the README on a clean machine and it works.

### F21 · Skills and conventions review

- **Goal:** the rules we built are easy to follow for people and AI agents.
- **Scope:**
    - Skills in `.claude/skills/`, each with steps, file paths, commands and a "never do" list, kept to 80 lines or fewer:
        - `add-module`
        - `add-endpoint`
        - `add-consumer`
        - `add-migration`
        - `add-config`
        - `write-tests`
    - A pass over `CONVENTIONS.md` and `CLAUDE.md` to make them match the code exactly.
- **Done when:** each skill is checked by following it to add a throwaway module locally.

### F22 · Docker image

- **Goal:** one small, safe image for the API and every worker.
- **Scope:**
    - A multi-stage Dockerfile on Node 24 slim, running as non-root.
    - Production dependencies only, source maps on, and `HEALTHCHECK`.
    - `.dockerignore`.
    - An image build step in CI.
- **Done when:** the image starts as the API and as a worker locally, and stays under an agreed size.

### F23 · AWS foundation (CDK)

- **Goal:** infrastructure as code from the first resource.
- **Scope:**
    - A CDK app in `deploy/` with per-environment config.
    - Lookup of the existing VPC.
    - ECR repository, ECS cluster, log groups, Secrets Manager entries, and an IAM baseline.
- **Done when:** `cdk synth` passes in CI and `cdk deploy` creates the base in staging.

### F24 · AWS data and queues

- **Scope:**
    - **ElastiCache for Valkey.**
    - **Base SQS queues and DLQs.**
    - **EventBridge Scheduler wiring** from F18.
    - **A script that creates the `messaging` database and its users on the existing cluster:**
        - read-only on `main`;
        - read and write on `messaging`;
        - later, write access only to the legacy WhatsApp collections, for M8.
- **Done when:** staging has these resources and the readiness checks connect to them.

### F25 · AWS services and staging deploy

- **Scope:** ECS Fargate services: `api` behind an internal ALB, and one worker service. Autoscaling basics, and deployment circuit breaker with rollback.
- **Done when:** staging serves `/health/ready` through the ALB and the worker processes a test message.

### F26 · Deploy pipeline and runbook

- **Scope:**
    - **GitHub Actions with OIDC to AWS:**
        1. Build the image, then push to ECR.
        2. Run migrations.
        3. Deploy to staging on merge.
        4. Deploy to production after a manual approval.
    - **`docs/RUNBOOK.md`:** what runs where, release order, rollback, and secrets rotation.
- **Done when:** a merge deploys to staging automatically, and a rollback is rehearsed once.

## Phase 2 · Messaging (WhatsApp campaigns)

The design is in [docs/modules/messaging/](modules/messaging/README.md), with the decisions in [ADR-0015](adr/0015-whatsapp-messaging.md). Everything through M16 is built and verified locally, against `mock-meta` instead of Meta. M17 changes HeliumAdmin; M18 needs AWS.

### M1 · Messaging design and plan

- **Goal:** one agreed design, in this repo, that matches the code we have.
- **Scope:**
    - Inventory what HeliumAdmin and the storefront do today, and their problems.
    - Reconcile the earlier 12-doc design with ADRs 0002–0014: ADR-0015 and `docs/modules/messaging/` (README, design, data model, API).
    - The feature list, including new features (scheduling, send window, test send, frequency cap, retargeting, duplicate, speed cap, cost, attribution, inbox).
    - Detailed blocks for M2–M18.
- **Done when:** the docs are committed and every task below has a scope and a "Done when".

### M2 · WhatsApp building blocks

- **Goal:** the pure pieces every later task uses, fully unit-tested.
- **Scope:**
    - A `messaging` module skeleton and its config (`WA_*`: Graph version and URL, access token, app secrets, verify token, account IDs, max rate, opt-out keywords, price card).
    - The Graph client: send on `/messages` and `/marketing_messages`, media upload, template list, phone-number fields; keep-alive, timeouts, no retries; results returned as `ok` or a classified error, with "ambiguous" for timeouts after the request was written.
    - Error classification tables ([design.md](modules/messaging/design.md#errors)).
    - Phone normalization (digits with country code, India default, HeliumAdmin's rules).
    - Template helpers: placeholders per component, parameter resolution from the variable mapping, building the send payload with header media and URL buttons.
- **Done when:** unit tests cover every error class and code list, phone edge cases, and parameter resolution for header, body and buttons, matching HeliumAdmin's behaviour.

### M3 · Webhook intake

- **Goal:** Meta's webhooks are accepted in milliseconds and never lost.
- **Scope:**
    - Signature verification (two secrets) and the payload splitter, as plain TypeScript.
    - `GET` and `POST /webhooks/whatsapp`: public, raw body, no database or Redis, publish to `wa-status`, `wa-inbound`, `wa-account`; 500 if anything stays unsent.
    - The three queues with DLQs (elasticmq.conf, deploy/config/queues.ts) and their message types.
- **Done when:** HTTP tests show a bad signature gets 401 and queues nothing, a mixed payload lands on the right queues, a queue failure gets 500, and the verification challenge works.

### M4 · mock-meta

- **Goal:** the whole system runs locally against a realistic fake Meta.
- **Scope:**
    - A small HTTP server in `tools/mock-meta/`: `/messages`, `/marketing_messages`, media, templates and phone-number fields.
    - A per-number rate limit returning 130429, latency from a configured p50 and p99, and errors chosen by the recipient's last digits (131026, timeout after write, 131049, 190).
    - Signed status webhooks (`sent`, `delivered`, `read`) to the local webhook route, with delays, duplicates and reordering; `biz_opaque_callback_data` echoed.
    - `POST /_sim/inbound` for replies and button taps; `GET /_sim/sent` for asserting zero duplicates.
    - `pnpm dev` starts it; `.env.example` points the Graph URL at it.
- **Done when:** a send through the Graph client to mock-meta produces signed webhooks that the webhook route accepts.

### M5 · Messaging data model

- **Goal:** the collections and indexes in [data-model.md](modules/messaging/data-model.md), owned by repositories.
- **Scope:**
    - Mongoose schemas and repositories for accounts, templates, media, deliveries, inbound messages, conversations, suppressions and unmatched statuses (`campaigns` and `exports` come with M10 and M13).
    - A migration that creates the collections and indexes.
    - The WhatsApp account seeded from config at start (one account today).
    - Templates are filled by the sync (M9); test audiences are seeded with the audience build (M11).
- **Done when:** the migration applies on an empty database and again with no changes; repository integration tests cover the bulk writers and their conditions.

### M6 · Sender

- **Goal:** every message leaves through one rate-limited, at-most-once sender.
- **Scope:**
    - `wa-send-p1` and `wa-send-p2`; the sender consumer polling p1 before p2.
    - Lua `takeTokens`, `refundTokens`, `onRateLimited`, `maybeRaiseRate`; the gate (kill switch, account and number pauses).
    - Claims, the call to Meta, result classification, batched flush (one `bulkWrite`, then counters, then deletes), unknown results to `wa:unconfirmed`, the wamid map, the daily-limit HyperLogLog.
    - Campaign state and suppression checks before sending.
- **Done when:**
    - Lua tests show the bucket and its reserve hold under 50 parallel callers;
    - integration tests against mock-meta show each error class handled;
    - killing the sender mid-flush and restarting gives zero duplicate sends.

### M7 · Status consumer

- **Goal:** statuses are applied once, in batches, with exact counters.
- **Scope:**
    - Correlation (callback data, wamid map, index, then hold and `unmatched_statuses`).
    - Lua `transition` with counters; merged `bulkWrite` guarded by rank; pricing categories.
- **Done when:** tests show duplicates, reordering, `failed` after `sent`, and `read` without `delivered` all give the right status and counters, and 1,000 statuses become one database write.

### M8 · Inbound consumer and auto-reply

- **Goal:** every reply is kept, attributed correctly, and acted on once.
- **Scope:**
    - Inbound messages and conversations; the service window.
    - Attribution through `context.id`; `delivery.reply`; button tallies; `replied` counted once.
    - Opt-out keywords and buttons → suppressions and `wa:supp`.
    - Auto-reply (text or template, any button or any reply, per-button text) through `wa-send-p1`, once per recipient, skipped when stale.
- **Done when:** tests show a duplicate webhook stores one message, a reply to campaign A is never attributed to campaign B, STOP suppresses the number, and an auto-reply is sent exactly once under duplicates.

### M9 · Account events and template sync

- **Goal:** Meta's account events keep campaigns safe without anyone watching.
- **Scope:**
    - The account consumer: template status, quality and category; phone quality; messaging limit; account restrictions.
    - Template sync from Meta every 15 minutes (`messaging-jobs`) and on demand.
    - Automatic pause hooks used by campaigns (M12).
- **Done when:** tests show a paused template pauses its campaigns, quality RED pauses marketing on the number, and a sync adds, updates and removes templates.

### M10 · Campaign API and uploads

- **Goal:** HeliumAdmin can create and manage campaign drafts through the API.
- **Scope:**
    - The `campaigns` module: schema, repository, migration.
    - Create, read, list, edit, delete and duplicate drafts, with HeliumAdmin's validations (approved template, complete mapping, header media, auto-reply) plus the new options (send window, frequency cap, speed cap, attribution window).
    - The `BlobStore` interface with a local-disk store; `POST /media` (stored, uploaded to Meta); `POST /uploads/csv` (stored, columns and rows counted, up to 1M rows).
    - Roles and permissions in `permissions.ts`; idempotency and audit on every mutation.
    - (The audience preview and filter options moved to M11, with the audience queries.)
- **Done when:** HTTP tests cover each route's success and refusal cases, including permissions, idempotent retries and the audit entries.

### M11 · Audience build

- **Goal:** any audience, up to millions, becomes pending deliveries without touching checkout performance.
- **Scope:**
    - `campaign-control.fifo` and the control consumer; `campaign.command.build`.
    - `POST /audiences/preview` (count, breakdown, a rendered sample) and `GET /audiences/options`.
    - Sources: users, orders (all HeliumAdmin filters), abandoned carts, waitlist, individual users, CSV, and an earlier campaign's results.
    - Normalize, de-duplicate, exclusions, suppressions, frequency cap, parameter resolution, `insertMany` in batches with `seq` blocks, heartbeat, resumable.
- **Done when:** integration tests show each source and filter gives the expected recipients, a crashed build resumes with no duplicates, and skipped counts are exact.

### M12 · Lifecycle, feeder and sweeper

- **Goal:** campaigns run, pause, resume, stop and finish by themselves.
- **Scope:**
    - Commands: start (with pre-flight checks and the large-audience guard), schedule and cancel, pause, resume, stop, test send; automatic pauses from M6 and M9.
    - The feeder: leader lock, backlog target, round-robin, speed cap, send window, daily-limit guard; a worker "loop" alongside consumers.
    - The sweeper: due schedules, unknown results, completion, close after 72 h, stuck builds.
    - Header media refresh before start.
- **Done when:** integration tests show every lifecycle transition, pause and stop take effect within 5 s with nothing sent after, a send window holds and releases a campaign, and two campaigns on one number share it fairly.

### M13 · Campaign reads, export and attribution

- **Goal:** everything HeliumAdmin shows about a campaign, fast.
- **Scope:**
    - Live stats with rate, estimated finish and cost; the recipients table with filters (status, reply, search); replies and poll results.
    - Async CSV export (all of HeliumAdmin's columns) to the blob store, then download.
    - Order attribution from the main database.
- **Done when:** HTTP tests cover each read; an export of 100k rows streams without loading them in memory; attribution matches a hand-made fixture.

### M14 · Inbox, direct messages and suppressions

- **Goal:** the contacts screen and a real inbox, on the same pipeline.
- **Scope:**
    - Conversations list, contact profile and timeline, mark read, search.
    - Direct template sends and free-text replies (24-hour window) through `wa-send-p1`.
    - Suppression list, add, remove and import.
- **Done when:** HTTP tests show a reply opens the window, a free-text send outside it is refused, and the timeline merges deliveries and inbound messages in order.

### M15 · Messaging operations

- **Goal:** operators can see and control the system without a deploy.
- **Scope:** queue and DLQ stats, the kill switch, DLQ redrive, counter reconcile, account resume; the runbook section for messaging.
- **Done when:** HTTP tests cover each route, and reconcile rebuilds exact counters after the Redis keys are deleted.

### M16 · End-to-end and load test (local)

- **Goal:** proof that the whole system meets its targets.
- **Scope:**
    - A scripted local run: a 100k-recipient campaign through mock-meta with errors, duplicates and reordering.
    - Pause, resume and stop in the middle; replies, button taps, opt-outs and auto-replies; a second campaign at the same time.
    - A webhook burst test against the local route.
- **Done when:** counts are exact, `/_sim/sent` shows zero duplicates, auto-replies are sent once, opt-outs are honored, and send rate, status lag and webhook latency are recorded in the module README.

### M17 · HeliumAdmin integration

- **Goal:** admins use the new engine from the screens they know.
- **Scope:**
    - A backend client in HeliumAdmin (service token with the admin in `act`).
    - Campaign, inbox and ops screens calling the API, including the new features; behind a `MESSAGING_ENGINE` flag, with v1 campaigns read-only.
- **Done when:** with the flag on, a campaign can be created, built, tested, scheduled, run, paused, stopped and exported against the local backend and mock-meta.

### M18 · Rollout

- **Goal:** production runs on the new engine, and the v1 worker is gone.
- **Scope:**
    - Deploy (F25, F26) with the messaging queues; the webhook route or a Lambda. The CDK app gets the `WA_*` settings per environment and the WhatsApp secrets (access token, app secrets, verify token) in Secrets Manager.
    - A smoke test with the real number on a 5-number list.
    - Switch Meta's callback URL when no v1 campaign is sending.
    - Canary: 1k, 10k, 100k recipients, comparing with v1.
    - Then retire the v1 worker and webhook route.
- **Done when:** 14 days in production with no P1 alarm, and the v1 worker is retired.


## Open items (needed before the tasks named)

| Item | Needed by | Owner |
| --- | --- | --- |
| ~~GitHub repo location and who reviews PRs~~ Resolved: github.com/adarshroy001/HeliumHelper, no reviewers requested automatically (CODEOWNERS removed) | F5 | Done |
| AWS: separate staging account or prefixed stacks in one account | F23 | You |
| DocumentDB admin access to create the `messaging` database and users | F24 | You |
| Meta: a test app and number for a real smoke test (local work uses mock-meta) | M16 | You |
| Slack channel for alerts | M18 | You |
| Admin roles in HeliumAdmin (everyone is `admin` until then) | M17 | You |
| Recorded WhatsApp marketing opt-in for storefront users (Meta policy, DPDP) | M18 | You |
