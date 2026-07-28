# ADR 0005 — Domain events over an event-bus port for cross-context integration

**Status:** Accepted

## Context
Recovery Intelligence must react to changes everywhere (damage assessed, aid recorded, project
completed, issue resolved) to recompute village health scores; Social Media Intelligence raises
alerts that reference registry state. Direct cross-context calls or shared tables would couple
contexts and break the context map's rules.

## Decision
- Every state-changing use case emits **domain events** (defined in the owning context, with a
  stable name and payload of primitives/IDs — the published language).
- Use cases receive an `EventPublisher` **port**; the MVP adapter is a synchronous in-process bus,
  with a Supabase-table outbox adapter as the path to durable/async delivery.
- Event names are versioned strings (`village.damage-assessed.v1`); payloads carry IDs, never
  aggregates.
- Subscribing contexts register handlers against the bus in the composition root; handlers call
  that context's own use cases.

## Consequences
- Recovery Intelligence stays decoupled: it can be rebuilt or re-weighted without touching
  producers.
- Event emission is testable London-style (assert publisher interactions).
- Eventual consistency between contexts is accepted; the UI reads projections, not joins across
  contexts.
