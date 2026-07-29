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
| [0008](0008-supabase-auth-identity.md) | Supabase Auth for identity: email/password and Google, without a browser SDK | Accepted |
| [0009](0009-authorization-roles-and-ownership.md) | Authorization: roles plus record ownership, enforced in the application layer | Accepted |
| [0010](0010-actor-context-propagation.md) | Propagating the actor: request-scoped composition and an actor-stamping publisher | Accepted |
| [0011](0011-audit-trail-from-domain-events.md) | The audit trail is the domain event stream, made durable and attributed | **Proposed** |
| [0012](0012-location-capture-and-coordinate-provenance.md) | Location capture: GPS, map pin or geocode, with provenance recorded | **Proposed** |
| [0013](0013-village-detail-and-amendment.md) | Viewing and amending a village: correction is not the same as change | Accepted |
| [0014](0014-membership-on-a-shared-supabase-project.md) | Membership is explicit: no auto-enrolment on a shared Supabase project | Accepted |
| [0015](0015-ending-a-session.md) | Ending a session: deliberate, reachable, and automatic | Accepted |

0008–0011 form one coherent change — identity, what identities may do, how identity reaches the
code that needs it, and what gets recorded. 0008, 0009 and 0010 are **built and their migrations are
applied**; 0011 is not started. 0014 amends 0008 after contact with the shared project: it removes
the auto-enrolment 0008 had assumed was safe. 0012 is independent of all of them.

0015 covers the other end of a session: the sign-out ADR 0008 built but left reachable from only one
of five views, plus an idle timeout for the tab nobody closes.

**Deployed.** The production service runs 0008 + 0009 + 0010 + 0014 with the shared `API_TOKEN`
retired, so every caller signs in and role enforcement applies. See
`docs/DEPLOYMENT.md`.
