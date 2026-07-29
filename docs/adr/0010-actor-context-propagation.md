# ADR 0010 — Propagating the actor: request-scoped composition and an actor-stamping publisher

**Status:** Proposed

## Context

ADR 0009 needs to know who is acting in order to authorize. ADR 0011 needs to know who acted in
order to audit. Both requirements bottom out in the same mechanical problem: **the identity
established at the HTTP edge has to reach code that runs deep inside a use case.**

The obstacle is the existing shape of the codebase. There are now more than forty use cases, every
one of them following the convention set in ADR 0001:

```ts
class RegisterVillage {
  constructor(private readonly deps: RegisterVillageDeps) {}
  async execute(input: RegisterVillageInput): Promise<Result<Output>> { … }
}
```

Domain events — which are what audit actually needs — are published from inside `execute`, via the
injected `EventPublisher` port. So the actor has to be available at that point, roughly forty
times over, without turning the change into a forty-file signature rewrite that invalidates the
entire London-school test suite.

## Decision

**Compose the platform per request, and let an actor-aware `EventPublisher` decorator stamp the
actor onto every event.** No use case signature changes.

`createPlatform` already accepts overrides and already builds every use case from injected ports
(extended in the Supabase and multi-context work). The API constructs a platform per request, or
retrieves a cached one, passing the authenticated actor:

```ts
const platform = createPlatform({
  repositories,                       // shared, stateless
  eventPublisher: new ActorStampingPublisher(bus, actor),
});
```

`ActorStampingPublisher` implements `EventPublisher`, decorating each `DomainEvent` with the
actor before delegating:

```ts
async publish(events: DomainEvent[]): Promise<void> {
  return this.inner.publish(events.map((e) => ({
    ...e,
    actor: { id: this.actor.id, email: this.actor.email, role: this.actor.role },
    requestId: this.actor.requestId,
  })));
}
```

Every state change in this platform already emits an event (ADR 0005). That property — built for
cross-context integration, not for audit — turns out to give a complete, actor-attributed audit
trail for the cost of one decorator. This is the payoff for a decision made several ADRs ago, and
it is the reason this ADR is short.

**Authorization, by contrast, stays explicit at the API boundary.** The route handler checks
`may(actor, action, resource)` before invoking the use case. Authorization is not smuggled through
the publisher, because a permission check that happens invisibly is a permission check nobody can
find when it is wrong.

## Alternatives considered

**Add an `actor` parameter to every `execute`.** The most explicit option, and under other
circumstances the right one — it makes the dependency visible in the type system and impossible to
forget. Rejected on cost: forty-odd use cases and their tests rewritten, for a parameter that
almost every one of them would immediately hand to the publisher untouched. Worth reconsidering if
use cases ever need the actor for *domain* reasons, at which point explicitness earns its price.

**`AsyncLocalStorage` ambient context.** Zero signature changes and the actor is available
anywhere. Rejected on testability, which this codebase has consistently prioritised (ADR 0003):
ambient state is invisible at the call site, easy to forget to set in a test, and produces failures
that are hard to trace. It also leaks a Node-specific runtime concept into code that is otherwise
plain TypeScript.

**Put the actor in each use case's `input` object.** No constructor changes, and explicit. Rejected
because it conflates *what the user asked for* with *who is asking*, and would put an `actor` field
into forty input types that model domain requests. `RegisterVillageInput` describes a village, not
a session.

**Audit at the HTTP layer instead — log method, path and status.** Much simpler. Rejected because
it records requests, not changes: it cannot say that an aid record was flagged as a duplicate, only
that a POST returned 201. The PRD's accountability requirement is about *what changed in the
domain*, which is exactly what the event stream already carries.

## Consequences

- Forty-plus use cases and their existing tests are untouched. The change concentrates in the
  composition root, one decorator, and the API's request pipeline.
- Per-request composition must stay cheap. Wiring is object construction over shared, stateless
  repositories — but this makes it a **performance-relevant invariant**: if an expensive resource
  (a database connection, a key set) ever gets constructed inside `createPlatform`, per-request
  composition silently becomes a per-request cost. Repositories and clients must be built once and
  injected in.
- `DomainEvent` gains optional `actor` and `requestId` fields. Optional, because events raised by
  system processes (a scheduled anomaly sweep) genuinely have no human actor — and "system" must be
  representable honestly rather than attributed to whoever last logged in.
- The in-process event bus is still per-instance (ADR 0005's known limitation), so audit
  persistence must be a subscriber that writes durably, not an in-memory accumulation.
- Because stamping happens in one place, it is also a single point of failure: if the decorator is
  omitted from a composition path, events silently lose attribution. That deserves a test asserting
  every event published through a request-scoped platform carries an actor.
