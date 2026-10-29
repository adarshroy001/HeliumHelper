# Delivery plan

Last updated: 2026-10-28

We build `helium-backend` one small task at a time. Each task is one branch and one PR, and ends with a review stop. The next task starts only after the previous one is approved.

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
| F5 | CI pipeline and repo hygiene | F3, F4 | Done (PR #1 awaiting merge) |
| F6 | Config | F5 | Done |
| F7 | Logging and request context | F6 | Done |
| F8 | Error handling | F7 | Done |
| F9 | Validation and API docs | F8 | Done |
| F10 | HTTP setup and health | F9 | Done |
| F11 | Authentication and access control | F10 | In review |
| F12 | MongoDB connections and repositories | F10 | In review |
| F13 | Migrations | F12 | In review |
| F14 | Redis | F10 | In review |
| F15 | Rate limiting and idempotency | F11, F14 | In review |
| F16 | Queue publisher | F10 | In review |
| F17 | Queue consumer runner and worker process | F16 | In review |
| F18 | Scheduled jobs | F17 | In review |
| F19 | Audit log | F12 | In review |
| F20 | Local development polish | F17 | In review |
| F21 | Skills and conventions review | F20 | In review |
| F22 | Docker image | F17 | In review |
| F23 | AWS foundation (CDK) | F22 | In review |
| F24 | AWS data and queues | F23 | In review |
| F25 | AWS services and staging deploy | F24 | Not started |
| F26 | Deploy pipeline and runbook | F25 | Not started |
| M1–M21 | Messaging (below) | F26 | Not started |

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

The detailed design is in the Helium-Production repo under `docs/architecture/messaging-platform/` (12 docs). M1 moves it here and reconciles it with these ADRs. Each M task gets the same detailed block as the F tasks when M1 is done.

| ID | Task | Outcome |
| --- | --- | --- |
| M1 | Messaging design in this repo | The 12 docs are moved to `docs/modules/messaging/` and updated for NestJS and this structure. M2–M21 get detailed task blocks |
| M2 | WhatsApp client | Graph API client for `messages` and `marketing_messages`, with timeouts and the error classification tables |
| M3 | Webhook verification and parsing | Signature check and payload parser as plain TS, shared by the Lambda and the tests |
| M4 | mock-meta | A local fake of the Graph API that sends signed webhooks back, with configurable rate limits and errors |
| M5 | Webhook Lambda | Verify, split, enqueue and return 200, plus a local HTTP adapter |
| M6 | Messaging data model | Accounts, campaigns, deliveries, inbound messages, suppressions, with migrations and indexes |
| M7 | Status consumer | Batched status transitions with the Redis Lua script and `bulkWrite` |
| M8 | Legacy v1 adapter | Statuses for today's campaigns and direct messages are applied to the old collections |
| M9 | Inbound consumer | Inbox, service window, opt-out, button tallies |
| M10 | Auto-reply | Auto-replies queued once per recipient |
| M11 | Account events | Template, quality and messaging-limit events, with automatic pause |
| M12 | Sender, part 1 | Token bucket and adaptive rate in Lua |
| M13 | Sender, part 2 | Send loop, claims, batched results, ambiguous-send handling |
| M14 | Ops endpoints | Kill switch, queue stats, DLQ redrive |
| M15 | Load test and webhook cutover | Staging load and chaos tests, then Meta's callback URL is switched |
| M16 | Campaign API | Create, validate, template sync, uploads |
| M17 | Audience build | Control consumer that writes pending deliveries |
| M18 | Feeder and lifecycle | Feeder, start, pause, resume, stop, sweeper, schedules |
| M19 | Campaign reads | Stats, deliveries, replies, export |
| M20 | HeliumAdmin integration | API client, feature flag, screens |
| M21 | Rollout | Canary, then retire the v1 worker |

## Open items (needed before the tasks named)

| Item | Needed by | Owner |
| --- | --- | --- |
| ~~GitHub repo location and who reviews PRs~~ Resolved: github.com/adarshroy001/HeliumHelper, reviewer adarshroy001 (add more in CODEOWNERS) | F5 | Done |
| AWS: separate staging account or prefixed stacks in one account | F23 | You |
| DocumentDB admin access to create the `messaging` database and users | F24 | You |
| Meta: a staging app and a test number | M5 | You |
| Slack channel for alerts | F26 | You |
