# ADR-0008 · One error contract

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Clients need machine-readable error codes to react correctly, and support needs a reference to find the failing request. Workers need to know whether a failure is worth retrying.

CrediTouch shows the cost of not deciding this:

- every module's errors were kept in one 1,400-line file;
- some services threw framework exceptions directly;
- docs promised codes the code never sent.

## Decision

- **Every expected failure is an `AppError` subclass** (`src/common/errors/`) with:
    - `code`: `SCREAMING_SNAKE_CASE`, stable, never reused;
    - `status`: the HTTP status;
    - `message`: safe to show a user;
    - `details`: optional and structured;
    - `retryable`: for workers;
    - `cause`: the original error, for logs only.
- **Each module keeps its own errors** in `*.errors.ts`.
- **Services and consumers throw `AppError`s only.** Never `HttpException`, never a bare `Error`.
- **One global exception filter returns this body on every error response:**

```json
{ "statusCode": 404, "code": "CAMPAIGN_NOT_FOUND", "message": "Campaign not found.", "details": {}, "requestId": "…" }
```

- **Validation failures** are 400 `VALIDATION_FAILED`, with `details.fields` mapping each path to a message.
- **Rate limits** are 429 `RATE_LIMITED`, with `details.retryAfterSeconds`.
- **Unknown errors** are 500 `INTERNAL_ERROR` with a generic message. Only errors of 500 and above are logged at error level and reported.
- **Workers** map `retryable: true` to retry and `false` to park in the DLQ.

## Alternatives considered

- **RFC 9457 `problem+json`:** a fine standard, but it adds fields (`type` URIs, `instance`) we have no use for. Our callers are our own apps. The shape above can be served as `problem+json` later if a public API needs it.
- **Nest's default error body:** no stable codes.

## Consequences

- A test in F8 pins the exact shape. Changing it requires a new ADR.
- Error codes are listed in each module's README, so frontend code can rely on them.
