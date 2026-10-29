# ADR-0014 · Toolchain versions

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

[ADR-0003](0003-nestjs.md) chose NestJS and asked F1 to prove that NestJS 12, released August 2026, works with every library we need before we build on it.

F1 built a throwaway app with:

- two named Mongoose connections;
- zod validation on `@Body` and `@Query`;
- Swagger generated from zod;
- pino logs and a request context;
- health checks and rate limiting.

It was tested with Vitest and supertest against a real MongoDB 7 container, then compiled with `tsc` and run as a plain Node process.

## Decision

**NestJS 12 as an ESM project, with these versions.** Renovate or Dependabot proposes updates later.

| Area | Package | Version |
| --- | --- | --- |
| Runtime | Node.js | 24 LTS (`engines: >=24`; tested on 24.16.0) |
| Package manager | pnpm | 12.15.0 (`packageManager` field) |
| Language | TypeScript | **6.0.x** (6.0.3) |
| Framework | `@nestjs/core`, `common`, `platform-express`, `testing` | 12.3.2 |
| | `@nestjs/cli` | 12.0.11 |
| | `@nestjs/config` | 12.0.1 |
| | `@nestjs/mongoose` | 12.0.0 |
| | `@nestjs/swagger` | 12.0.5 |
| | `@nestjs/terminus` | 12.1.0 |
| | `@nestjs/throttler` | 6.7.1 |
| Database | mongoose | 9.11.4 |
| Validation | zod | 4.6.7 |
| Logging and context | `nestjs-pino` 5.3.1, `pino` 10.4.0, `pino-http` 11.0.0, `nestjs-cls` 7.0.2 | |
| Other runtime | `reflect-metadata` 0.2.2, `rxjs` 7.8.2, `helmet` 8.3.0 (added in F10) | |
| Tests | vitest 5.0.5, supertest 7.3.1, testcontainers and `@testcontainers/mongodb` 12.2.1, image `mongo:7.0` | |
| Lint and format (F3) | eslint 10.x, typescript-eslint 8.72.x, prettier 3.9.x, husky 9, lint-staged 17, commitlint 21 | |

### How each piece is used

- **ESM, not CommonJS.**
    - Every NestJS 12 package is ESM (`"type": "module"`), so an ESM project uses them natively.
    - tsconfig uses `module` and `moduleResolution` set to `nodenext`.
    - Relative imports must end in `.js`. The compiler rejects a missing extension, so it can never fail at runtime.
- **TypeScript 6.0, not 7.**
    - TypeScript 7.0.2 (the native compiler) is the npm `latest`.
    - But `@nestjs/swagger` 12 declares TypeScript up to 6.x, and `typescript-eslint` 8.72 supports TypeScript below 6.1.
    - We move to 7 when both support it.
- **Build:** plain `tsc` (Nest CLI's default builder). No webpack or Rspack bundling for the server. Lambdas are bundled separately with esbuild (M5).
- **Decorator metadata:** `experimentalDecorators` and `emitDecoratorMetadata` are on.
    - `tsc` emits the metadata for builds.
    - Vitest 5 handles decorator metadata without the SWC plugin: the spike's DI-heavy tests passed both with and without `unplugin-swc`. So **no SWC plugin**.
- **Validation:**
    - NestJS 12's built-in `StandardSchemaValidationPipe` is registered globally.
    - Routes attach zod schemas with `@Body({ schema })`, `@Query({ schema })` and `@Param({ schema })`.
    - `z.strictObject` rejects unknown keys. `z.coerce` handles query numbers.
    - No third-party wrapper (`nestjs-zod`) is needed.
- **OpenAPI:** `SwaggerModule.createDocument(…, { standardSchemaConverter })`, using `z.toJSONSchema(schema, { io, target: 'openapi-3.0' })`. Limits, defaults and `additionalProperties: false` all appear in the generated document.
    - *Update (F9):* no converter is needed. zod 4.6 implements Standard JSON Schema (`~standard.jsonSchema`), which `@nestjs/swagger` 12 reads directly with `target: 'openapi-3.0'`.
- **Install-script security:**
    - pnpm 12 blocks dependency install scripts unless they are allowed.
    - `pnpm-workspace.yaml` keeps an explicit `allowBuilds` map.
    - Only packages that need it are allowed; the swagger-ui telemetry package `@scarf/scarf` and testcontainers' optional SSH native modules are denied.

## Alternatives considered

- **NestJS 11 (CommonJS):** proven, but we would migrate to 12 within months. Nothing we need failed on 12.
- **A CommonJS project on NestJS 12:** works through Node's `require(esm)` support, but means working against the framework's own module format.
- **TypeScript 7:** blocked by the peer ranges above.
- **Nest's ESM defaults of Rspack and oxlint:** a bundler adds nothing for a long-running server. oxlint lacks the type-aware rules we enforce, such as `no-floating-promises`. ESLint with typescript-eslint stays (F3).

## Consequences

- **Integration and HTTP tests need Docker running locally.** The first run pulls `mongo:7.0` (about 60 s); later runs reuse it.
- **Findings handed to later tasks:**
    - **F7:**
        - `pino-http` and `nestjs-cls` each generated their own request ID when the header was missing. One generator must feed both.
        - The default access log includes every request header. Trim it to method, url, status and duration.
    - **F8:** the built-in pipe's error body is Nest's default (`message: string[]`). F8 supplies an `exceptionFactory` that maps issues to `VALIDATION_FAILED` with `details.fields`. The issue paths are available.
    - **F10:** remove the `X-Powered-By` header (helmet does this).
    - **F12:** testcontainers' MongoDB URI needs `directConnection=true`.
    - **F14 and F16:** `ioredis` 6.0.0 and `@aws-sdk/client-sqs` are not covered by this spike. Those tasks confirm them.
