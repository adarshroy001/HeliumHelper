<!-- PR title = the squash commit message on main: a Conventional Commit, e.g. "feat(config): typed config (F6)". -->

## Task

<!-- Plan task ID and name, e.g. "F6 · Config". One task per PR (docs/PLAN.md). -->

## What changed and why

<!-- A few lines. Link the ADR if this PR adds or changes a decision. -->

## How it was verified

<!-- Tests added, manual checks run, anything a reviewer should try. -->

## Definition of Done

- [ ] The task's "Done when" criteria in `docs/PLAN.md` are met
- [ ] CI (`check`) is green: format, lint, typecheck, unit, integration and HTTP tests, build
- [ ] New behaviour has tests, including the failure paths
- [ ] No `any`, no unawaited promises, no `console.log`, no secrets in code or logs
- [ ] Docs affected by the change are updated (CONVENTIONS, CLAUDE.md, ADR, module README, skills)
- [ ] `docs/PLAN.md` status is updated
