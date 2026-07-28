# ADR 0001 — Hexagonal architecture with one package per bounded context

**Status:** Accepted

## Context
The PRD (docs/PRD.md) identifies nine bounded contexts of differing volatility: stable core
registries (village, beneficiary), rule-heavy accountability contexts (funds, issues), and a
volatile AI-facing context (social media intelligence). Contexts must be independently testable,
independently evolvable, and must not leak persistence or AI-vendor concerns into domain logic.

## Decision
Each bounded context is an npm workspace package with a hexagonal (ports & adapters) layout:

```
packages/<context>/
  src/domain/         # aggregates, value objects, domain events, domain errors
  src/application/    # use cases (application services) + ports (interfaces)
  src/adapters/       # in-memory fakes; Supabase repositories
  test/               # outside-in unit tests (mocked ports)
```

Rules:
- `domain/` imports nothing outside the package except `@afrip/shared-kernel`.
- `application/` defines ports (repository, clock, event-publisher, AI-extractor interfaces);
  use cases depend only on ports.
- `adapters/` implement ports; nothing in `domain/` or `application/` imports an adapter.
- Contexts share only identifiers and event contracts from the shared kernel — never entities.

## Consequences
- Domain logic is 100% unit-testable with mocks/fakes (enables ADR 0003).
- Supabase can be adopted per-context without touching domain code (ADR 0004).
- The social-media AI extractor is a swappable port; vendor churn is contained (anti-corruption layer).
- Some duplication between contexts (e.g. similar repository shapes) is accepted as the price of autonomy.
