# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-hexagonal-architecture-bounded-contexts.md) | Hexagonal architecture with one package per bounded context | Accepted |
| [0002](0002-typescript-monorepo-vitest.md) | TypeScript monorepo (npm workspaces) with Vitest | Accepted |
| [0003](0003-tdd-london-school.md) | London-school (mockist, outside-in) TDD | Accepted |
| [0004](0004-supabase-primary-store.md) | Supabase (Postgres) as primary data store behind repository ports | Accepted |
| [0005](0005-domain-events-event-bus.md) | Domain events over an event-bus port for cross-context integration | Accepted |
| [0006](0006-agent-swarm-build-process.md) | Ruflo agent swarm build with model-to-complexity matching | Accepted |
| [0007](0007-phased-delivery.md) | Phase-wise delivery: Foundations → Accountability → Intelligence | Accepted |
| [0008](0008-supabase-auth-identity.md) | Supabase Auth for identity: email/password and Google, without a browser SDK | **Proposed** |
| [0009](0009-authorization-roles-and-ownership.md) | Authorization: roles plus record ownership, enforced in the application layer | **Proposed** |
| [0010](0010-actor-context-propagation.md) | Propagating the actor: request-scoped composition and an actor-stamping publisher | **Proposed** |
| [0011](0011-audit-trail-from-domain-events.md) | The audit trail is the domain event stream, made durable and attributed | **Proposed** |

0008–0011 form one coherent change — identity, what identities may do, how identity reaches the
code that needs it, and what gets recorded. They are **Proposed**: written to be argued with before
any of them is built.
