# ADR-0002 · A separate backend: `helium-backend`

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Helium runs two Next.js apps, the storefront and HeliumAdmin. Both use the same MongoDB (DocumentDB) database and each defines its own Mongoose schemas for the same collections. Background work, such as notifications, webhooks and the WhatsApp campaign worker, runs inline in web requests or on a single EC2 box. That has caused database load problems and lost or duplicated work.

We need a home for queue-based work now, starting with WhatsApp campaigns, and for business logic that moves out of the Next.js apps over time.

## Decision

- **One new repository and service, `helium-backend`.** It is a **modular monolith**: a single NestJS codebase made of business modules with strict boundaries, deployed as several processes from one image.
    - The **API** process serves HTTP.
    - **Worker** processes run queue consumers and scheduled jobs.
    - Small **Lambdas** handle webhook intake.
- **Messaging (WhatsApp campaigns and notifications) is the first module.** Orders, payments and other domains move in later, one module at a time (the strangler pattern). There is no big-bang rewrite.
- **Long term, the backend owns the data and logic of every domain it takes over.** The storefront and admin call its API instead of sharing collections. Schemas move with their logic, so no shared schema package is needed.

## Alternatives considered

- **A folder inside HeliumAdmin:** it couples deploys, and the storefront would depend on the admin repo.
- **Microservices from the start:** network calls, separate deploys and data consistency problems before we need them.
- **A monorepo with internal packages and Turborepo:** more structure than our size needs today. It can be adopted later if a second deployable truly needs separate dependencies.

## Consequences

- One `package.json`, one build and one image keep it simple to run and change.
- Module boundaries must be enforced by lint and review ([ADR-0004](0004-project-structure.md)), or the monolith becomes tangled.
- A module that later needs to scale or deploy on its own can be moved out, because it only talks to others through its public API, events or queues.
