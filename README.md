# helium-backend

Helium's backend: a NestJS modular monolith for APIs, background workers and integrations. Its first module is messaging (WhatsApp campaigns and notifications). Other domains move in over time.

**Status:** foundation in progress. See the status table in [docs/PLAN.md](docs/PLAN.md).

## Getting started

**Prerequisites:**

- Node.js 24 (`.nvmrc`). The install fails on any other major version.
- Corepack, which ships with Node. It provides the exact pnpm version pinned in `package.json`.

**Steps:**

```bash
corepack enable          # once per machine; or prefix each command with `corepack`
pnpm install
cp .env.example .env     # local settings; the app refuses to start if any value is invalid
pnpm dev                 # API on http://localhost:3000
curl http://localhost:3000/health/live
```

Docker, local services and seed data are added in later tasks (F12, F14, F16, F20).

[![CI](https://github.com/adarshroy001/HeliumHelper/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/adarshroy001/HeliumHelper/actions/workflows/ci.yml)

## Documentation

| Doc | What it's for |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | Ordered tasks, their scope and "done" criteria, and their status |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | How we work and the rules for code |
| [docs/adr/](docs/adr/README.md) | Architecture decisions and why |
| [CLAUDE.md](CLAUDE.md) | Short guide for AI coding agents |

Getting started, the commands and the runbook arrive with tasks F2, F20 and F26.
