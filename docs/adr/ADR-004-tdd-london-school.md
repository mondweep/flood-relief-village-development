# ADR-004: TDD, London School (outside-in, mock-driven)

**Status:** Accepted · **Date:** 2026-07-28

## Context

The platform's value is in its invariants (One Village One NGO, budget ledger ordering,
duplicate-aid detection, follow-up guarantees). These must be specified before code and
protected against regression. The team builds with an agent swarm, so tests are also the
contract that keeps parallel agents honest.

## Decision

Adopt **London-School TDD** for all contexts:

1. **Outside-in:** start each feature at the use case (application service), writing the
   test that expresses the FR-ID from the PRD (test names cite FR-IDs — NFR-6).
2. **Mock the ports:** repositories, event publishers, clocks and cross-context lookups are
   Vitest mocks. Tests verify **behavior** — which collaborators were called, with what —
   not persisted state.
3. **Drive design with mocks:** a port's interface is discovered by writing the
   collaboration test first; the domain stays pure and I/O-free.
4. **Red → Green → Refactor**, committed in that discipline per feature.
5. State-based assertions are allowed only *inside* pure domain units (value objects,
   aggregate methods) where there are no collaborators to verify.
6. In-memory fakes are provided per port for coarse-grained context tests, but invariant
   coverage lives in the mock-driven unit tests.

## Consequences

- No test requires a database or network; the suite stays fast enough for swarm iteration.
- Interfaces (ports) emerge from use-case needs, keeping adapters thin.
- Risk of over-mocking is bounded by rule 5 (pure domain tested state-based).
