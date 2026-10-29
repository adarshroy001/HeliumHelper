# ADR-0013 · Logging and observability

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

We must be able to answer three questions: what happened to this request or message, is anything stuck, and what is failing. We must answer them without leaking customer data or secrets into logs.

## Decision

- **Structured JSON logs with pino** (`nestjs-pino`).
    - Logs go to stdout; ECS and Lambda ship them to CloudWatch Logs.
    - Output is pretty-printed in local development only.
- **Every log line carries `requestId`** (HTTP) or `correlationId` (queue message), held in `nestjs-cls` request context.
- **Redaction:**
    - authorization headers, cookies, tokens and secrets are removed by config;
    - phone numbers are masked (`+91******4321`);
    - message bodies are never logged at `info` or above.
- **Metrics:** CloudWatch metrics from logs and AWS services first, such as queue age, DLQ depth, ECS CPU and errors. Custom metrics use CloudWatch Embedded Metric Format when a task needs them.
- **Alarms:** every queue alarms on oldest-message age and DLQ depth. The API alarms on its 5xx rate. Alarms are defined in CDK.
- **Tracing (OpenTelemetry) and error tracking (Sentry) are not in the foundation.** They are added by an ADR when debugging needs them. The X-Ray SDKs are in maintenance mode, so tracing will use OpenTelemetry.

## Alternatives considered

- **A hosted logging vendor now:** extra cost and data leaving AWS, before we know we need it.
- **`@nestjs/observe`, new in NestJS 12:** NestJS-only and very new. Revisit when it matures.

## Consequences

- F7 delivers logging and request context. The alarms come with each queue and service as they are built.
