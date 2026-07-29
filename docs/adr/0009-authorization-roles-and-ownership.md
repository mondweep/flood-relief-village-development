# ADR 0009 — Authorization: roles plus record ownership, enforced in the application layer

**Status:** Accepted — built, migrations applied, **not yet deployed**

## Context

ADR 0008 gives the platform authenticated users. It does not say what any of them may *do*.

The PRD (§4) already names the personas: district officer, NGO coordinator, village committee
member, citizen/donor, volunteer. Their needs differ sharply — a district officer must see fund
anomalies across every village, a citizen must see none of the beneficiary registry, an NGO
coordinator must see only the villages they are assigned. The requirement adds one more rule that
cuts across all of them: **a user may edit entries they created.**

That last rule is the awkward one. "Editable by its creator" is not a property any AFRIP aggregate
currently has, because creator is not a flood-recovery concept. `Village`, `Beneficiary` and
`FundedProject` know nothing about users and should continue to know nothing about users: whether
`affectedFamilies <= households` has no bearing on who typed the number in.

So the design question is not *what* the rules are, but *where they live* — and the tempting
answer (put a `createdBy` field on every aggregate and check it in the domain) would contaminate
nine bounded contexts with a concern none of them owns.

## Decision

### The role model

Five roles, mapping to the PRD personas:

| Role | Intent |
|---|---|
| `admin` | Platform administration; full read, full write, user management. `mondweep@dxsure.uk` bootstrapped here |
| `district_officer` | Read across all villages; sanction and monitor funds; verify projects |
| `ngo_coordinator` | Write within assigned villages; manage beneficiaries, aid and projects there |
| `village_committee` | Write within their own village; report and verify issues |
| `citizen` | **Default for self-registration.** Read the public projection; report issues; edit their own entries |

Self-registration grants `citizen` and nothing more. Elevation to any other role is an
administrative act, never self-service — a platform whose whole point is accountability cannot let
someone assign themselves authority over fund records by filling in a form.

### Authorization is an application-layer concern, not a domain one

Aggregates stay ignorant of users. Authorization is enforced in the **application layer**, at the
use-case boundary, because the question "may this actor invoke this operation?" is a question
about the *invocation*, not about the flood-recovery invariant being protected.

Concretely, a `Permission` check runs before a use case executes, against an `ActorContext`
(ADR 0010). Nothing in `src/domain/` gains a user, a role, or a `createdBy`.

### Ownership lives in a separate record-ownership table

Rather than adding `created_by` to twenty-three tables and to every aggregate that maps to them,
ownership is recorded once, out of band:

```sql
assam_floods.record_ownership (
  record_type text not null,   -- 'village' | 'beneficiary' | 'issue' | …
  record_id   text not null,
  owner_id    uuid not null,   -- auth.users.id
  created_at  timestamptz not null default now(),
  primary key (record_type, record_id)
)
```

An `OwnershipRegistry` port records ownership when a creating use case succeeds, and answers
`isOwner(actor, recordType, recordId)` when an editing use case is attempted. Aggregates are
untouched; the mapping is pure infrastructure.

This is the load-bearing decision in this ADR, and it is a genuine trade-off. A join table is less
efficient than a column, and it can drift from the records it describes if a write path forgets to
register ownership. We accept both costs to keep nine bounded contexts free of an identity concept
they have no business knowing about — and the drift risk is mitigated by registering ownership in
the same place that publishes the creation event, so a creating use case cannot do one without the
other.

### The permission rule

```
may(actor, action, resource) :=
     actor.role == 'admin'
  or roleGrants(actor.role, action, resource.scope)
  or (action is an edit and ownershipRegistry.isOwner(actor, resource))
```

Ownership **widens** rights, never narrows them: a district officer may edit a village they did not
create. And ownership grants *edit*, never *delete* — nothing in this platform is deletable by a
non-admin, because a beneficiary record that can be made to disappear is exactly the failure mode
the product exists to prevent.

### RLS as defence in depth, not as the mechanism

Postgres RLS policies (extending `00002_rls_policies.sql`) are tightened to match the role model,
now that ADR 0008 issues real claims. But RLS is the **second** line: the API holds the
service-role key and bypasses RLS entirely, so RLS protects against a leaked publishable key and
direct PostgREST access, not against a bug in our own authorization code. Treating RLS as the
primary control would be a mistake given how the API actually connects.

## Alternatives considered

**`createdBy` on every aggregate.** Simplest to implement and the most efficient to query.
Rejected because it puts an identity concept inside `Village`, `Beneficiary` and seven other
aggregates that have no use for it, contradicting ADR 0001's rule that contexts share only
identifiers. The cost lands on every future reader of the domain model, forever.

**RLS as the only enforcement.** Elegant — one place, database-enforced, impossible to forget.
Rejected because the API connects with the service-role key, which bypasses RLS by design; making
RLS primary would mean giving up the service-role connection and rewriting every adapter to
propagate user JWTs. Worth revisiting if the architecture ever moves to per-user connections.

**Attribute-based access control (ABAC) / a policy engine.** More expressive, and genuinely better
if the rules multiply. Rejected as premature: five roles and one ownership rule do not justify a
policy language, and an under-exercised policy engine is harder to reason about than an explicit
function.

**Let users delete their own entries.** Rejected. Append-only is a product requirement in
disguise — the PRD's whole complaint is that records vanish. Edits are recorded as changes
(ADR 0011), not as overwrites of history.

## Consequences

- The domain layer stays clean; no aggregate gains a user concept. Existing domain tests are
  unaffected.
- Every creating use case acquires a second obligation (register ownership) and every editing use
  case a precondition. Both must be *tested for absence too* — a create path that silently fails to
  register ownership produces a record its author cannot edit, which will read as a permissions bug.
- `record_ownership` can drift if a write path is added later without registering. A periodic
  reconciliation check, or a test that every create-shaped use case registers ownership, is
  warranted.
- Role changes need an admin UI or at least an admin endpoint; until that exists, elevation is a
  SQL statement, which should be stated plainly rather than discovered.
- The five roles are a guess at the real organisational shape. Expect them to be wrong in detail
  after contact with actual district administrations, and keep the mapping in one place so it is
  cheap to change.

## What was built, and where it falls short of this ADR

Written after implementation. Each of these is a place the ADR promises more than the code delivers,
and none of them is visible from the role names alone.

**Village and NGO scoping is NOT enforced.** This ADR says an NGO coordinator writes "within
assigned villages" and a village committee member "within their own village". Neither is true in the
implementation: both roles get platform-wide write within their permitted operations. The reason is
that nothing links a user account to an NGO or to a committee — assignments are NGO→village, and
committee membership is not tied to an auth identity. `user_profiles` has no `ngo_id` or
`village_id`, so there is nothing to join on, in the application layer or in RLS. Closing this needs
a data-model change, not a policy change. **Until then the role names imply a scope that does not
exist.**

**`district_officer` holds every permission, so it is `admin` in all but name.** Every role set in
`permissions.ts` includes it. The one thing this ADR reserves to `admin` is user management, which
has no use case — role grants are a SQL insert into `role_grants`. Pinned by a test
(`auth-jwt.test.ts`) so that the distinction cannot be assumed to exist, and so that adding a
genuinely admin-only operation fails that test and forces a deliberate update.

**On the legacy `API_TOKEN` path this layer does nothing.** Every request arrives with a null actor,
which is allowed by design. Role enforcement bites only on the JWT path. The production service is
still on the token, so ADR 0009 is currently inert in production despite being built and tested.

**Ownership widening is reachable in fewer places than it looks.** `correctVillageProfile` and the
plan use cases are marked `ownable`, but only roles that may already invoke them can create the
records in question, so the clause is unreachable today. It bites on issues (anyone may report one)
and on volunteers. A policy-table test rejects the stronger version of this mistake — a rule that
grants every role *and* declares `ownable`, which reads as "your own record" while enforcing
"anybody's".
