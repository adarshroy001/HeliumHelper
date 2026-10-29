# ADR-0003 · NestJS on Node.js 24 LTS, with TypeScript strict

- **Status:** Accepted. The exact versions and module format are decided in F1, ADR-0014.
- **Date:** 2026-10-28

## Context

The backend will grow to many modules and contributors. It needs:

- a consistent module structure;
- dependency injection that makes testing easy;
- standard places for guards, pipes, interceptors and filters;
- a way to run the same modules as an HTTP API and as a worker without HTTP.

## Decision

- **NestJS**, using Express as the HTTP adapter, which is Nest's default and has the broadest ecosystem support.
    - The API uses `NestFactory.create`.
    - Workers use `NestFactory.createApplicationContext`, which loads the same modules with no HTTP server.
- **Node.js 24 LTS** everywhere, which matches the AWS Lambda `nodejs24.x` runtime.
- **TypeScript in strict mode**, with `noUncheckedIndexedAccess` on.
- **pnpm** as the package manager.
- **NestJS 12** (released August 2026; 12.1.1 in September 2026) is the target. It adds Standard Schema validation (zod directly on `@Body`/`@Query`/`@Param`) and ships ESM packages.
    - Because it is new, F1 checks that the libraries we need work with it.
    - If any fails, we use NestJS 11 and record why in ADR-0014.

## Alternatives considered

- **Fastify or Express on its own:** lighter, but every structural decision (DI, module layout, guards) would be ours to invent and police.
- **The Fastify adapter for Nest:** faster raw throughput, which our API traffic doesn't need, and weaker compatibility with some middleware.

## Consequences

- Contributors need basic NestJS knowledge. The skills in `.claude/skills/` (F21) cover our patterns.
- Decorator metadata needs build and test tooling that supports it. F1 and F4 configure this.
