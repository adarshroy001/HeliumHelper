# Architecture decision records

How we write them: [ADR-0001](0001-record-architecture-decisions.md).

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-separate-backend-service.md) | A separate backend, `helium-backend`, as a modular monolith | Accepted |
| [0003](0003-nestjs.md) | NestJS on Node.js 24 LTS, TypeScript strict | Accepted (versions in 0014) |
| [0004](0004-project-structure.md) | Project structure and module boundaries | Accepted |
| [0005](0005-database.md) | MongoDB: Mongoose, named connections, migrations | Accepted |
| [0006](0006-async-work.md) | Async work: SQS, worker processes, scheduled jobs | Accepted |
| [0007](0007-redis.md) | Redis (Valkey) for coordination only | Accepted |
| [0008](0008-error-contract.md) | One error contract | Accepted |
| [0009](0009-validation.md) | Validation with zod | Accepted |
| [0010](0010-auth-and-access.md) | Authentication and access control | Accepted |
| [0011](0011-hosting.md) | Hosting: ECS Fargate, Lambda for webhooks, CDK | Accepted |
| [0012](0012-testing.md) | Testing strategy | Accepted |
| [0013](0013-logging-and-observability.md) | Logging and observability | Accepted |
| [0014](0014-toolchain-versions.md) | Toolchain versions: NestJS 12 ESM, TypeScript 6.0, pnpm 12 | Accepted |
