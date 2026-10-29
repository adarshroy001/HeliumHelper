# ADR-0012 · Testing strategy

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Bugs in this backend are expensive: duplicate customer messages, lost webhooks, wrong data. Mocks hide integration bugs.

CrediTouch's "e2e" tests wired services by hand with no HTTP layer or guards, and ran as a database superuser, so whole classes of bugs were never tested.

## Decision

- **Vitest** for every test.
- **Three kinds of test:**

| Kind | Location | Tests | Uses |
| --- | --- | --- | --- |
| Unit | `src/**/*.spec.ts`, next to the code | Business rules and pure logic | Plain functions, or services with simple fakes |
| Integration | `src/**/*.int-spec.ts` | Repositories, consumers, Redis scripts, queue runner | Real MongoDB, Valkey and ElasticMQ in containers (testcontainers) |
| HTTP end-to-end | `test/**/*.e2e-spec.ts` | Whole requests through the real guards, pipes and filter | The full Nest app, with containers for its dependencies |

- **Every bug fix adds the test that would have caught it.**
- **Failure paths are tested,** not just happy paths: invalid input, missing permission, retries, crashes mid-work.
- **There are no coverage-percentage targets.** The Definition of Done requires tests for the behaviour that changed.
- **CI runs all three kinds on every PR.** GitHub's hosted runners have Docker.

## Alternatives considered

- **Jest:** slower, and NestJS 12's new-project default is Vitest.
- **An in-memory MongoDB or PGlite-style fakes:** fast, but they hide real database behaviour such as index use, transactions and DocumentDB differences.

## Consequences

- Integration tests need Docker locally.
- Container start-up is shared per test file to keep runs fast.
