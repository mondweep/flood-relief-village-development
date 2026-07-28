# AFRIP — AI-Powered Flood Recovery & Village Development Intelligence Platform

From emergency relief to long-term village development — one continuous platform.
**One Village → One NGO → One Village Leadership Team.**

## Documentation

| Document | What it covers |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Domain-driven PRD: ubiquitous language, bounded contexts, context map, aggregates + invariants + domain events, phased requirements |
| [docs/adr/](docs/adr/) | ADRs 0001–0007: hexagonal architecture, TypeScript monorepo, London-school TDD, Supabase, domain events, agent-swarm build, phased delivery |
| [supabase/](supabase/) | Deployable schema for every context, RLS policies, public transparency views |

## Layout

```
packages/
  shared-kernel/              Result, branded IDs, Money, DomainEvent, ports, test fakes
  village-registry/           Village profile, damage assessments, severity          [core]
  ngo-coordination/           One-active-NGO-per-village, capacity, committees        [core]
  beneficiary-registry/       Vulnerable persons, aid history, duplicate-aid flags    [core]
  fund-monitoring/            Sanctioned/released/spent arithmetic, anomaly rules     [core]
  recovery-intelligence/      11-dimension village health score, recommendations      [core]
  social-media-intelligence/  SignalExtractor ACL port, deterministic smart alerts    [core]
  issue-tracking/             Citizen issues, status machine, routing policy          [supporting]
  volunteer-management/       Registration, assignment, hours, leaderboard            [supporting]
  development-planning/       Long-term goals and milestones per village              [supporting]
  platform/                   Composition root: wires contexts over the event bus
```

Each context is hexagonal: `src/domain` (aggregates, value objects, policies), `src/application`
(use cases + ports), `src/adapters` (in-memory fakes; Supabase repositories). Contexts share only
identifiers and event contracts — integration happens through domain events, never direct calls.

## Build and test

```bash
npm install
npm test          # vitest: 536 tests
npm run typecheck # tsc --noEmit, strict
```

Everything runs against in-memory adapters, so no database or API keys are needed. The Supabase
migrations are the deployable persistence artifact (see `supabase/README.md`).

## How this was built

Phase-wise, by a Ruflo agent swarm with models matched to task complexity (ADR 0006): one
London-school TDD agent per bounded context in parallel, then an adversarial review wave whose ten
confirmed findings were each fixed test-first.
