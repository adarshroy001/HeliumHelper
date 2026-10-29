# ADR-0009 · Validation with zod

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Inputs arrive from many places: HTTP bodies, query strings, environment variables, queue messages and webhooks. Using a different validation tool for each place means different rules and gaps. CrediTouch left 17 query parameters unvalidated.

## Decision

- **zod (v4) is the one validation library.** It covers request body, query and params; environment config; queue message envelopes and payloads; webhook payloads; and responses where we need to be sure what leaves the API.
- **In controllers, schemas are attached through NestJS 12's Standard Schema support**, or the equivalent pipe if F1 chooses NestJS 11.
- **TypeScript types are inferred from the schemas** with `z.infer`, so the type and the check can't disagree.
- **Objects are strict:** unknown keys are rejected, not silently dropped.
- **Query values are coerced** explicitly (numbers, booleans, dates) by shared helpers.
- **Swagger docs are generated from the same schemas.**

## Alternatives considered

- **class-validator DTOs:** decorator-heavy, can't be reused for env or queue messages, and no longer NestJS 12's default.
- **Hand-written checks:** inconsistent, and easy to forget.

## Consequences

- One skill (`add-endpoint`) shows the pattern for request and response schemas.
- Schemas can later be shared with frontend code if we choose to, because zod runs in the browser too.
