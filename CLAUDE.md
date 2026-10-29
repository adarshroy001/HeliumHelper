# CLAUDE.md

Guide for AI coding agents working in this repo. Keep it short. Link to docs instead of copying them.

## What this is

`helium-backend` is Helium's NestJS backend: one codebase that runs as an HTTP API, as background workers, and as small Lambdas. See [ADR-0002](docs/adr/0002-separate-backend-service.md).

**Current stage:** foundation (see the status table in [docs/PLAN.md](docs/PLAN.md)). The app has a scaffold and `GET /health/live`. There is no business code yet.

**Toolchain** ([ADR-0014](docs/adr/0014-toolchain-versions.md)): Node 24, pnpm 12, TypeScript 6.0 (not 7), NestJS 12 as an ESM project. Relative imports end in `.js`. zod goes on `@Body({ schema })` and `@Query({ schema })`.

## Before you do anything

1. Find the task in [docs/PLAN.md](docs/PLAN.md). Work on **one task only**, within its scope.
2. Follow [docs/CONVENTIONS.md](docs/CONVENTIONS.md): the workflow, the Definition of Done and rules R1–R17.
3. A change that contradicts an ADR in [docs/adr/](docs/adr/README.md) needs a new ADR first.
4. When the task is done, stop and ask for review. Don't start the next task.
5. Never commit. People commit.

## Structure

See [ADR-0004](docs/adr/0004-project-structure.md).

```text
src/config  src/common  src/infrastructure  src/modules/<name>  src/lambdas
migrations/  test/  deploy/  docs/  .claude/skills/
```

## Commands

Run pnpm through Corepack (`corepack pnpm …`), or `corepack enable` once and then use `pnpm` directly.

| Command | Does |
| --- | --- |
| `pnpm install` | Install exact versions from the lockfile |
| `pnpm dev` | Run the API in watch mode |
| `pnpm build` | Compile to `dist/` with `tsc` |
| `pnpm start` | Run the compiled API (`dist/main.js`) |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm lint` / `pnpm lint:fix` | ESLint (every rule is an error) |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm test` / `pnpm test:watch` | Unit tests (`src/**/*.spec.ts`, `eslint/**/*.spec.ts`) |
| `pnpm test:int` | Integration tests (`src/**/*.int-spec.ts`, real containers; Docker from F12) |
| `pnpm test:e2e` | HTTP tests (`test/**/*.e2e-spec.ts`) |
| `pnpm test:cov` | All tests with a coverage report in `coverage/` |

Migrations (F13) are added by that task. Git hooks run lint-staged on commit and commitlint on the message.

**Writing tests:**

- HTTP tests boot the real app with `createTestApp()` from `test/helpers/create-test-app.ts`, then call `request(t.http)`. It applies the same `configureApp()` as `main.ts`.
- Global app setup goes in `src/app.setup.ts`, never only in `main.ts`, so tests run what production runs.

## Hard rules (summary)

- Layers: controller → service → repository. Only repositories touch Mongoose.
- Use other modules only through their `index.ts`. No `forwardRef`.
- zod validates every input. Services throw `AppError` subclasses only.
- Every route declares `@Public()` or `@RequirePermissions()`.
- No `any`, no unawaited promises, no `process.env` outside `src/config`, no secrets or raw phone numbers in logs.
- Files stay at 400 lines or fewer.
- Update docs and skills in the same change.
