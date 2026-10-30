# helium-backend

Helium's backend: a NestJS modular monolith for APIs, background workers and integrations. Its first module is messaging (WhatsApp campaigns and notifications). Other domains move in over time.

[![CI](https://github.com/adarshroy001/HeliumHelper/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/adarshroy001/HeliumHelper/actions/workflows/ci.yml)

**Status:** see the status table in [docs/PLAN.md](docs/PLAN.md).

## Getting started

### Prerequisites

| Tool | Version | Check |
| --- | --- | --- |
| Node.js | 24 (`.nvmrc`). The install refuses any other major version | `node -v` |
| Corepack | Ships with Node. Provides the exact pnpm version pinned in `package.json` | `corepack -v` |
| Docker Desktop (or Docker Engine with Compose v2) | Running. Local MongoDB, Valkey and ElasticMQ run in containers, and so do the integration tests | `docker compose version` |
| Git | Any recent | `git --version` |

Free ports: 3000 (API), 3001 (worker health), 27017 (MongoDB), 6379 (Valkey), 9324 (ElasticMQ).

### First run

```bash
git clone https://github.com/adarshroy001/HeliumHelper.git helium-backend
cd helium-backend
corepack enable        # once per machine, so `pnpm` works; or prefix each command with `corepack`
pnpm install
pnpm dev               # creates .env, starts the containers, migrates, runs the API and the worker
```

When you see `API on http://localhost:3000`, in a second terminal:

```bash
curl http://localhost:3000/health/ready     # {"status":"ok", ...}: MongoDB and Valkey are reachable
pnpm seed                                   # sample customers in the local `main` database
pnpm dev:token --roles <role>               # a token for calling /internal/v1 routes
```

The API docs are at http://localhost:3000/docs. Every 5 minutes the worker logs `scheduler heartbeat`: the scheduler, the queue and the worker all work.

`Ctrl+C` stops the API and the worker. The containers keep running; `docker compose down` stops them (add `-v` to delete their data).

### Everyday commands

| Command | Does |
| --- | --- |
| `pnpm dev` | Containers, migrations, then the API and the worker, restarted on every change |
| `pnpm test` | Unit tests (fast, no Docker) |
| `pnpm test:int` / `pnpm test:e2e` | Integration and HTTP tests (they start their own containers; Docker must be running) |
| `pnpm lint` / `pnpm format` / `pnpm typecheck` | The checks CI runs |
| `pnpm migrate:create "what it does"` | A new migration in `src/migrations/` |
| `pnpm migrate` / `pnpm migrate:status` | Apply or list migrations |
| `pnpm schedules:export` | After changing a schedule |

The full list, and how to write code here, is in [CLAUDE.md](CLAUDE.md) and [docs/CONVENTIONS.md](docs/CONVENTIONS.md).

### Common problems

| Symptom | Fix |
| --- | --- |
| `pnpm: command not found` | Run `corepack enable`, or use `corepack pnpm ...` |
| `Unsupported engine` on install | Use Node 24 (`nvm use`, or install it from nodejs.org) |
| `Starting MongoDB, Valkey and ElasticMQ failed` | Start Docker Desktop and wait until it says it is running |
| `port is already allocated` | Something else uses the port. Stop it, or another copy of the containers (`docker ps`) |
| The app exits with `Invalid configuration` | It names each wrong variable. Compare `.env` with `.env.example`; delete `.env` to get a fresh copy |
| `startup failed` with `ECONNREFUSED` or `Connection is closed` | The containers aren't up: `docker compose up -d --wait` |
| A queue is missing locally | Add it to `docker/elasticmq.conf`, then `docker compose restart elasticmq` |
| Smoke tests show "skipped" on Windows | Expected: Windows has no SIGTERM. CI runs them on Linux |

## Documentation

| Doc | What it's for |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | Ordered tasks, their scope and "done" criteria, and their status |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | How we work and the rules for code |
| [docs/adr/](docs/adr/README.md) | Architecture decisions and why |
| [CLAUDE.md](CLAUDE.md) | Short guide for AI coding agents, with every command |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operating the deployed services |
| `src/modules/*/README.md` | What each module owns |
