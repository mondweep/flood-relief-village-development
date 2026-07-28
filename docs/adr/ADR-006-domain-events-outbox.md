# ADR-006: Cross-context integration via domain events and transactional outbox

**Status:** Accepted · **Date:** 2026-07-28

## Context

Bounded contexts must not reach into each other's data (ADR-001), yet the product depends
on cross-context reactions: an `IssueRouted` needs the NGO assignment; `AidRecorded` feeds
duplicate-aid alerts; `SeverityChanged` should surface unassigned villages.

## Decision

- Every aggregate mutation that other contexts care about emits a **domain event** (past
  tense, PRD §4.3) through an `EventPublisher` port.
- In production, events are written to the emitting context's `domain_events` table **in
  the same transaction** as the state change (transactional outbox), then fanned out by a
  worker (Supabase Edge Function + cron) with at-least-once delivery.
- Consumers are idempotent (client-generated UUIDs, NFR-3, make natural idempotency keys).
- In tests, `EventPublisher` is a mock (behavior verified); an in-memory synchronous bus
  serves coarse-grained tests.
- Synchronous cross-context *reads* are allowed only through named anti-corruption ports
  (e.g. `AssignmentLookup`), returning the consumer's own types.

## Consequences

- No distributed transactions; failure isolation between contexts.
- Eventual consistency across contexts is accepted and surfaced in UX (alert feeds).
- The outbox tables double as an audit log (NFR-1).
