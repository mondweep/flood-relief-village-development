# ADR 0003 — London-school (mockist, outside-in) TDD

**Status:** Accepted

## Context
Domain behaviour (assignment invariants, duplicate-aid flagging, fund-anomaly rules, issue
routing) is the product. Infrastructure (Supabase, AI extraction, notifications) is volatile and
partly unavailable at build time. We need tests that (a) drive design of collaborations between
use cases and ports, and (b) run without any infrastructure.

## Decision
Adopt **London-school TDD** as the working method for every feature:

1. **Outside-in:** start from a use-case test (application service), not from entities.
2. **Mock the ports:** repositories, clock, event publisher and AI extractor are mocked
   (`vi.fn()`) in use-case tests; assertions verify *interactions* (what was saved, what event was
   published) as well as returned results.
3. **Red → Green → Refactor**, committed per phase.
4. Aggregates/value objects get direct state-based unit tests where invariants live.
5. In-memory fakes (shared with future integration tests) back any test needing sequencing
   behaviour; Supabase adapters are covered by contract tests when a database is provisioned.
6. The **event publisher is always asserted**: emitting the right domain event is part of a use
   case's contract (ADR 0005), not an implementation detail.

## Consequences
- Ports are discovered from tests, keeping interfaces minimal and client-shaped.
- Domain tests run in milliseconds with zero infrastructure; CI needs no secrets.
- Risk of over-mocking is mitigated by rule 4 (state-based tests where the invariant lives) and by
  contract tests for adapters.
