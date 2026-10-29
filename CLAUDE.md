# CLAUDE.md

Guide for AI coding agents working in this repo. Keep it short. Link to docs instead of copying them.

## What this is

`helium-backend` is Helium's NestJS backend: one codebase that runs as an HTTP API (`src/main.ts`), as background workers (`src/worker.ts`), and as small Lambdas. See [ADR-0002](docs/adr/0002-separate-backend-service.md).

**Current stage:** the foundation is built (auth, MongoDB, Redis, queues, workers, schedules, audit, migrations); the first business module, messaging, starts with task M1. Modules so far: `system` (heartbeat), `audit`. Status: [docs/PLAN.md](docs/PLAN.md).

**Toolchain** ([ADR-0014](docs/adr/0014-toolchain-versions.md)): Node 24, pnpm 12, TypeScript 6.0 (not 7), NestJS 12 as an ESM project. Relative imports end in `.js`.

## Before you do anything

1. Find the tasks in [docs/PLAN.md](docs/PLAN.md). Work on a batch of **two to four tasks**, each within its own scope.
2. Follow [docs/CONVENTIONS.md](docs/CONVENTIONS.md): the workflow, the Definition of Done and rules R1–R17.
3. Use the skill for the job:

   | Skill | When |
   | --- | --- |
   | [add-module](.claude/skills/add-module/SKILL.md) | A new business feature folder |
   | [add-endpoint](.claude/skills/add-endpoint/SKILL.md) | A new `/internal/v1` route |
   | [add-consumer](.claude/skills/add-consumer/SKILL.md) | Background work: queue, consumer, schedule |
   | [add-migration](.claude/skills/add-migration/SKILL.md) | An index, collection or data change |
   | [add-config](.claude/skills/add-config/SKILL.md) | A new setting or secret |
   | [write-tests](.claude/skills/write-tests/SKILL.md) | Any test |

4. A change that contradicts an ADR in [docs/adr/](docs/adr/README.md) needs a new ADR first.
5. When the batch is done, stop and ask for review. Don't start the next batch.
6. Commit in small Conventional Commits on the batch branch (`task/<first-id>-<last-id>-<name>`) and push it. Never add a `Co-Authored-By` or other attribution trailer. Never push to `main` directly; it changes only through a reviewed PR.

## Structure

See [ADR-0004](docs/adr/0004-project-structure.md).

```text
src/config  src/common  src/infrastructure  src/modules/<name>  src/lambdas  src/migrations
test/  deploy/  docker/  scripts/  docs/  .claude/skills/
```

## Commands

Run pnpm through Corepack (`corepack pnpm …`), or `corepack enable` once and then use `pnpm` directly.

| Command | Does |
| --- | --- |
| `pnpm install` | Install exact versions from the lockfile |
| `pnpm dev` | Start the containers (MongoDB replica set, Valkey, ElasticMQ), migrate, then run the API and the worker in watch mode |
| `pnpm seed` | Sample data in the local databases (refuses outside `APP_ENV=local`) |
| `docker compose up -d` / `down` | Start or stop only the containers |
| `pnpm build` | Compile to `dist/` with `tsc` |
| `pnpm start` / `pnpm start:worker` | Run the compiled API (`dist/main.js`) or worker (`dist/worker.js`) |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | Type-check; ESLint (every rule is an error); Prettier |
| `pnpm test` | Unit tests (`src/**/*.spec.ts`, `eslint/**/*.spec.ts`), no Docker |
| `pnpm test:int` / `pnpm test:e2e` | Integration (`src/**/*.int-spec.ts`) and HTTP (`test/**/*.e2e-spec.ts`) tests; Docker must run |
| `pnpm test:smoke` | The built app as a process (`test/smoke/`; `pnpm build` first; SIGTERM tests skip on Windows) |
| `pnpm test:cov` | All tests with a coverage report in `coverage/` |
| `pnpm dev:token --roles <roles>` | A 5-minute service token for calling the local API |
| `pnpm migrate` / `migrate:status` / `migrate:create <name>` | Apply, list, or add a migration (each builds first) |
| `pnpm schedules:export` | Write `deploy/schedules.json` from `src/schedules.ts` |

Git hooks run lint-staged on commit and commitlint on the message.

## Patterns (details in CONVENTIONS and the skills)

- **Routes:** `@InternalController('things')` (never `@Controller`); `@RequirePermissions('area:action')` or `@Public()`; `@CurrentActor()`; zod schemas on `@Body({ schema })`, `@Query({ schema })`, `@Param('id', { schema })`, types from `z.infer`, objects are `z.strictObject`; `@Idempotent()` on retryable mutations.
- **Errors:** `AppError` subclasses in `<module>.errors.ts`; the body is `{ statusCode, code, message, details?, requestId }`.
- **Data:** models on `DB.main` (read-only) or `DB.messaging`, used only by repositories; `findPage()` for lists; `withTransaction()` plus `AuditService.record(..., session)` for admin state changes; indexes only through migrations.
- **Async:** `defineMessage()` in the owning module; `QueuePublisher`; `@Consumer()` returning `ack()`/`retry()`/`park()`/`hold()`, imported into `WorkerModule`; crons as `defineSchedule()` in `src/schedules.ts`.
- **Redis:** inject `Redis` by class, coordination only; `redisKey()`, `luaScript()` + `runScript()`, `acquireLock()`.
- **Config:** inject a typed area (`@Inject(appConfig.KEY) private readonly app: AppConfig`); every variable in a zod schema and `.env.example`.
- **Logging:** inject `PinoLogger`, `setContext(MyClass.name)`, `logger.info({ fields }, 'constant message')`; never `@InjectPinoLogger`; `maskPhone()` for phones; the request ID is `ClsService.getId()`.
- **Global app setup** goes in `src/app.setup.ts`, never only in `main.ts`, so HTTP tests run what production runs.

## Hard rules (summary)

- Layers: controller → service → repository. Only repositories touch Mongoose.
- Use other modules only through their `index.ts`. No `forwardRef`.
- zod validates every input. Services throw `AppError` subclasses only.
- Every route declares `@Public()` or `@RequirePermissions()`.
- No `any`, no unawaited promises, no `process.env` outside `src/config`, no secrets or raw phone numbers in logs.
- Files stay at 400 lines or fewer.
- Update docs and skills in the same change.
