# deploy: AWS infrastructure (CDK)

Infrastructure as code for every environment ([ADR-0011](../docs/adr/0011-hosting.md)). One CDK app, `bin/app.ts`, written in TypeScript and run directly by Node 24. It is typechecked, linted and tested with the rest of the repo, and `cdk synth` runs in CI without AWS access.

## Layout

| Path | Holds |
| --- | --- |
| `config/environments.ts` | Per-environment values: account, region, VPC, subnets, sizes. `TODO(aws)` marks placeholders |
| `config/queues.ts` | Every SQS queue: visibility, retries, alarm thresholds |
| `schedules.json` | Generated from `src/schedules.ts` by `pnpm schedules:export`; one EventBridge schedule each |
| `lib/foundation-stack.ts` | VPC reference, ECR, ECS cluster, log groups, secrets, services security group, alarm topic (F23) |
| `lib/data-stack.ts` | Valkey, queues and DLQs with alarms, schedules, DocumentDB access (F24) |
| `lib/migration-stack.ts` | The migration task definition, run before each release (F25) |
| `lib/services-stack.ts` | The API behind an internal load balancer, and the worker (F25) |
| `lib/pipeline-stack.ts` | GitHub Actions' OIDC trust and deploy role (F26) |
| `scripts/` | `release.sh` (the release order, used by the pipeline) and the database users script |
| `test/` | Template assertions (`pnpm test` runs them) |

## Stacks per environment

`<prefix>-foundation` → `<prefix>-data` → `<prefix>-migration` → `<prefix>-services`, plus `<prefix>-pipeline`, where the prefix is `helium-staging` or `helium-production`. Each depends on the ones before it.

## Before the first deploy

1. Fill the `TODO(aws)` values in `config/environments.ts`: account ID, VPC and private subnet IDs, the DocumentDB cluster's security group, and HeliumAdmin's security group (or CIDRs). `cdk synth` warns while placeholders remain.
2. Bootstrap CDK once per account and region: `pnpm cdk bootstrap aws://<account>/ap-south-1`.
3. Follow "First-time setup" in the runbook: foundation, pipeline and data stacks, the database user, the secrets, then GitHub.

The full release procedure is in [docs/RUNBOOK.md](../docs/RUNBOOK.md).

## Commands

```bash
pnpm cdk synth --quiet                      # every template; fails on errors
pnpm cdk diff helium-staging-services       # what a deploy would change
pnpm cdk deploy helium-staging-foundation   # one stack
```
