---
name: write-tests
description: Write tests in helium-backend the project's way - which kind of test, where it goes, which helper to use, and the patterns for HTTP, database, Redis and queue tests. Use for any new behaviour.
---

# Write tests

## Which kind

| Kind | File | Use for | Run |
| --- | --- | --- | --- |
| Unit | `src/**/x.spec.ts`, next to the code | Pure logic, decisions, mapping | `pnpm test` |
| Integration | `src/**/x.int-spec.ts` | Repositories, Lua scripts, queue behaviour, against real containers | `pnpm test:int` |
| HTTP | `test/x.e2e-spec.ts` | Whole requests through the real app | `pnpm test:e2e` |
| Smoke | `test/smoke/x.smoke-spec.ts` | The built app as a process: signals, exit codes | `pnpm build && pnpm test:smoke` |

Containers (MongoDB, Valkey, ElasticMQ) start once per run in `test/global-setup.ts`; Docker must be running.

## Helpers

| Need | Helper |
| --- | --- |
| The real app | `createTestApp({ module?, override? })` → `{ app, http }`; `await t.app.close()` in `afterAll` |
| Extra test routes | A test controller in a `@Module({ imports: [AppModule], controllers: [...] })` |
| A caller's token | `signToken({ act: { id, email, roles } })` (`test/helpers/tokens.ts`); override `ROLE_PERMISSIONS` |
| Assert on logs | `LogCapture`; set `LOG_LEVEL=info` in `beforeAll`, back to `silent` after |
| A fresh database | `connectTestDatabase()`, then `dropAndClose()` |
| Redis | `connectTestRedis()`; keys with `redisKey(..., randomUUID())` |
| Queues | `testSqsClient()`, `createTestQueue(sqs, { dlq? })`, `receiveAll()` |

## Patterns

- Name tests for behaviour: `it('refuses a reused key with a different body (422)')`.
- Assert the exact error body for each failure: `{ statusCode, code, message, requestId }`.
- Cover the failure paths: invalid input, missing permission, each error code, dependency down.
- Changing env: copy `process.env` before, restore it in `afterAll`.
- Wait for async effects with `vi.waitFor(...)`, never a fixed `sleep` for success.
- Prove a test can fail: break the code once and watch it go red.

## Never

- Mock MongoDB, Redis or SQS in an integration test: use the containers.
- Share data between test files: unique databases, keys and queues.
- Read `process.env` in `src/**` tests (lint fails): go through a helper in `test/helpers`.
- Leave `it.only`, skipped tests without a reason, or `console.log`.
