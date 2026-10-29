# ADR-0004 · Project structure and module boundaries

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

A modular monolith stays healthy only if everyone agrees where code goes, and modules can't reach into each other. CrediTouch, our reference NestJS project, ended up with these problems:

- 13 files over 800 lines;
- 26 `forwardRef` cycles;
- a 1,400-line shared exceptions file;
- services issuing raw queries.

## Decision

The structure is one package:

```text
src/
  main.ts  worker.ts  app.module.ts  worker.module.ts
  config/            one zod-validated config file per area
  common/            used directly by features: errors, auth, validation, utils
  infrastructure/    connections to the outside world: database, redis, queue, logger, health
  modules/<name>/    one business feature; sub-features in sub-folders
    <feature>/       *.controller.ts *.service.ts *.repository.ts *.schema.ts
                     *.dto.ts *.errors.ts *.consumer.ts *.spec.ts
    <name>.module.ts
    index.ts         the module's public API: the only file other modules may import
    README.md        what the module owns: collections, queues, routes, events
  lambdas/           plain-TS Lambda handlers, no NestJS imports
migrations/  test/  deploy/  docs/  .claude/skills/
```

- **`common/` vs `infrastructure/`.**
    - `common/` holds code features call directly.
    - `infrastructure/` holds clients for external systems.
    - Neither may contain business rules.
- **Layers.**
    - Controllers translate HTTP and call services.
    - Consumers translate queue messages and call services.
    - Services hold business logic.
    - Repositories are the only code that touches Mongoose models.
- **Boundaries.**
    - A module imports another module only through its `index.ts`.
    - `forwardRef` is banned.
    - A side effect in another module goes through an exported service call or an event.
    - These are enforced by lint in F3.
- **Size.** 400 lines or fewer per file. A service that grows is split by use case, for example `start-campaign.service.ts`.
- **Errors** live with their module (`*.errors.ts`) and extend the shared `AppError` ([ADR-0008](0008-error-contract.md)).

## Alternatives considered

- **Layer-first folders** (`controllers/`, `services/`): a feature is scattered across the tree and boundaries are invisible.
- **Full DDD or hexagonal architecture** (ports, adapters, aggregates everywhere): more ceremony than our domains need. We can adopt parts inside a module that needs them.
- **One package per module (a monorepo):** see [ADR-0002](0002-separate-backend-service.md).

## Consequences

- Finding code is predictable: feature, then role suffix.
- Lint failures, not reviewers, stop boundary violations.
- A module can be extracted later because its surface is one `index.ts`.
