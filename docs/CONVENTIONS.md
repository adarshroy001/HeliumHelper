# Engineering conventions

Last updated: 2026-10-29

These are the rules for writing code in `helium-backend`. Where a rule can be checked by a tool, it is, and the "Enforced by" column says how. A rule marked *planned* becomes enforced in the task named.

If the code and this document disagree, fix one of them in the same PR. Never leave them disagreeing.

## How we work

1. **One task at a time.** Tasks come from [PLAN.md](PLAN.md). Each is small enough to review in one sitting.
2. **Before coding,** re-read the task block. If the scope is unclear or wrong, fix the plan first.
3. **One branch per task:** `task/<id>-<short-name>`, for example `task/f6-config`, branched from `main`.
4. **Build** with tests alongside the code, not after it.
5. **Update docs in the same PR:** this file, `CLAUDE.md`, an ADR, a module README or a skill, whichever the change affects.
6. **Self-review** against the Definition of Done below.
7. **Push the branch and open a PR** to `main` using the template. CI runs on the PR and again on every push to it.
8. **Stop at review.** The next task starts only after this one is approved and merged.
9. **Commits:** small, logical commits with Conventional Commit messages, for example `feat(config): validate env at startup`. No attribution trailers. The coding agent may commit and push task branches. Merging to `main` happens through a reviewed PR.

### Definition of Done

- [ ] The task's "Done when" criteria are met.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:int`, `pnpm test:e2e` and `pnpm build` pass locally, and the CI check `check` is green.
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
    5. build.
- **Dependabot** opens weekly update PRs for npm packages and GitHub Actions. It doesn't propose TypeScript 7 or `@types/node` majors (ADR-0014).
- **Branch protection for `main`,** set by a repo admin under GitHub → Settings → Branches (or Rulesets):
    1. Require a pull request before merging, with 1 approval, and dismiss stale approvals when new commits are pushed.
    2. Require status checks to pass: `check`. Require the branch to be up to date before merging.
    3. Require conversation resolution before merging.
    4. Block force pushes and deletions.

## Project structure

See [ADR-0004](adr/0004-project-structure.md) for the full tree.

| Folder | What goes here | What never goes here |
| --- | --- | --- |
| `src/` root files | `main.ts` (API start), `app.module.ts` (what the API loads), `app.setup.ts` (global setup shared with HTTP tests) | Business logic; global setup only in `main.ts` |
| `src/config/` | One zod-validated config file per area | Defaults that are only safe in development, unless checked against the environment |
| `src/common/` | Code features use directly: errors, auth guards and decorators, validation, small pure utils | Business rules; connections to external systems |
| `src/infrastructure/` | Connections to the outside world: database, Redis, queues, logger, health | Business rules |
| `src/modules/<name>/` | One business feature: controllers, services, repositories, schemas, DTOs, errors, consumers | Imports of another module's internals |
| `src/lambdas/` | Small AWS Lambda handlers in plain TypeScript | Anything from `@nestjs/*` |
| `migrations/` | Ordered MongoDB index and data migrations | Code that runs at app startup |
| `test/` | HTTP end-to-end tests and shared test helpers | Unit tests (those sit next to the code) |
| `deploy/` | AWS CDK | Application code |

## Rules

| # | Rule | Enforced by |
| --- | --- | --- |
| R1 | **Layers:** controller → service → repository. Controllers only translate HTTP. Services hold business logic and never import HTTP types. Only repositories touch Mongoose. Between folders, `config` imports only config; `common` imports config and common; `infrastructure` imports config, common and infrastructure; `modules` add other modules (via `index.ts`); `lambdas` import common and lambdas; nothing imports the root files (`main.ts`, `app.module.ts`) | Lint `helium/module-boundaries` for the folders; review for the layers inside a module |
| R2 | **Module boundaries:** another module is used only through its `index.ts`. Cross-module side effects go through events or queues. `forwardRef` is banned | Lint `helium/module-boundaries`, `no-restricted-imports` |
| R3 | **File size:** 400 lines or fewer per file, not counting blank lines and comments. A growing service is split by use case | Lint `max-lines` |
| R4 | **Types:** strict TypeScript. No `any`, no non-null `!`, no unawaited promises, `===` only. An exception needs an `eslint-disable-next-line` with a reason; unused disables fail lint | tsconfig + typescript-eslint `strictTypeChecked` |
| R5 | **Validation:** every input is validated with zod: body, query, params, env, queue messages, webhook payloads. Unknown keys are rejected | Validation pipe (*planned, F9*), review |
| R6 | **Errors:** throw an `AppError` subclass from the module's `*.errors.ts`. Never throw `HttpException` or a bare `Error` from services. Error codes are `SCREAMING_SNAKE_CASE`, unique, and never reused | Lint (*planned, F8*), review |
| R7 | **Access:** every route declares `@Public()` or `@RequirePermissions(...)`. Routes are denied by default | Global guards + route-coverage test (*planned, F11*) |
| R8 | **Data access:** queries are scoped and indexed. Lists use cursor pagination, never `skip`. Hot paths use `bulkWrite` and `lean()`. Transactions only when a use case needs them, kept short | Review; slow-query log |
| R9 | **Database writes:** the `main` database is read-only from this backend unless an ADR grants a module write access to specific collections | Database user permissions (*planned, F24*) |
| R10 | **Idempotency:** queue consumers are idempotent by a natural key. Mutating admin endpoints accept `Idempotency-Key` | Review; F15 interceptor |
| R11 | **Async work:** nothing slow or external runs inside an HTTP request that the caller waits on. Put it on a queue | Review |
| R12 | **Config:** read only through the typed config accessors. Never read `process.env` in feature code | Lint (*planned, F6*) |
| R13 | **Logging:** use the injected pino logger with structured fields. Phone numbers are masked; tokens, secrets and message bodies are never logged | Redaction config (*planned, F7*), review |
| R14 | **Tests:** unit tests for business rules (`*.spec.ts` next to the code), integration tests against real Mongo, Redis and SQS containers (`*.int-spec.ts` next to the code), and HTTP tests through the real app via `createTestApp()` (`test/*.e2e-spec.ts`). Tests use the same strict lint rules as app code | `pnpm test`, `test:int`, `test:e2e`; CI (*planned, F5*) |
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
