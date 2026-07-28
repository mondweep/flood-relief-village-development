# ADR-001: Modular monolith with hexagonal architecture per bounded context

**Status:** Accepted · **Date:** 2026-07-28

## Context

AFRIP spans nine bounded contexts (PRD §4). A microservice-per-context topology would
maximize isolation but the platform starts with one small team, one database (Supabase) and
an MVP scope. We still need hard context boundaries so contexts can be extracted later.

## Decision

Build a **modular monolith**: one TypeScript codebase, one deployable, with each bounded
context isolated under `src/contexts/<context>/` using **hexagonal architecture
(ports & adapters)**:

- `domain/` — aggregates, value objects, domain events, domain services. No imports from
  outside the context except the shared kernel. No I/O.
- `application/` — use cases (application services) depending only on `domain/` and ports.
- `infrastructure/` — adapters (Supabase repositories, in-memory fakes) implementing ports.

Cross-context communication happens only via domain events or explicitly named
anti-corruption lookups (e.g. Issue Tracking's `AssignmentLookup`), never by importing
another context's internals.

## Consequences

- Contexts are independently testable and extractable to services later.
- One deployment keeps MVP operations simple.
- Discipline is enforced by convention + lint (import boundaries), not process isolation.
