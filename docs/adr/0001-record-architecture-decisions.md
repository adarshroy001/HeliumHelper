# ADR-0001 · Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Decisions that live in chat threads or in people's heads get re-argued and forgotten. Long design documents go stale because nobody updates them. CrediTouch's 30–70 KB feature specs drifted from its code within weeks.

## Decision

- **Every significant decision gets an ADR** in `docs/adr/NNNN-short-title.md`: what we build with, how the code is structured, how data is owned, and any rule that changes how people write code.
- **Each ADR is one page:** Status, Date, Context, Decision, Alternatives considered, Consequences.
- **Status** is one of Proposed, Accepted, Superseded by ADR-NNNN, or Deprecated.
- **ADRs are append-only.** To change a decision, write a new ADR that supersedes it, and mark the old one superseded. Typo fixes are fine.
- **Feature design** goes in `docs/modules/<name>/`, kept short. Schemas and endpoints live in code and in the generated API docs, not copied into prose.
- **The rules that follow from ADRs** are summarized in [CONVENTIONS.md](../CONVENTIONS.md), which is the day-to-day reference.

## Alternatives considered

- **Long feature specs per module:** they duplicate the code and go stale.
- **A wiki outside the repo:** it isn't reviewed with the code and drifts.

## Consequences

- Reviewers can reject a PR that changes a decision without an ADR.
- The ADR list doubles as the onboarding reading list.
