<!-- PR title = the squash commit message on main: a Conventional Commit, e.g. "feat: auth and MongoDB (F11–F13)". -->

## Tasks

<!-- The batch's plan task IDs and names, e.g. "F11 · Auth, F12 · MongoDB". Two to four tasks per PR (docs/PLAN.md). -->

## What changed and why

<!-- A few lines. Link the ADR if this PR adds or changes a decision. -->

## How it was verified

<!-- Tests added, manual checks run, anything a reviewer should try. -->

## Definition of Done

- [ ] Each task's "Done when" criteria in `docs/PLAN.md` are met
- [ ] CI (`check`) is green: format, lint, typecheck, unit, integration and HTTP tests, build, smoke tests
- [ ] New behaviour has tests, including the failure paths
- [ ] No `any`, no unawaited promises, no `console.log`, no secrets in code or logs
- [ ] Docs affected by the change are updated (CONVENTIONS, CLAUDE.md, ADR, module README, skills)
- [ ] `docs/PLAN.md` status is updated
