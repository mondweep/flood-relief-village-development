# ADR 0011 — The audit trail is the domain event stream, made durable and attributed

**Status:** Accepted — implemented

## Context

The requirement is "audit logging should be working to track and report on changes". For this
product that is not an operational nicety — the PRD's opening complaint is that after 30–60 days
*nobody knows which village received what*, records of orphaned children disappear, and government
funds cannot be tracked. An audit trail is the mechanism by which the platform's central promise
is kept.

The platform already emits a domain event for every state change (ADR 0005), with versioned names
and primitive payloads, and ADR 0010 stamps each with its actor. The audit trail therefore does not
need to be *built*; it needs to be **kept**. Today those events are published to an in-process bus
and then discarded.

A second, subtler requirement hides inside "track changes": knowing *that* a village was updated is
much less useful than knowing *what changed*. `village.severity-updated.v1` already carries both
`severity` and `previous`, but not every event is so considerate.

## Decision

**Persist every domain event to an append-only audit log, and report from it.**

### Storage

```sql
assam_floods.audit_log (
  id           bigint generated always as identity primary key,
  event_name   text not null,              -- 'village.registered.v1'
  occurred_at  timestamptz not null,
  recorded_at  timestamptz not null default now(),
  actor_id     uuid,                       -- null = system-originated
  actor_email  text,                       -- denormalised: survives user deletion
  actor_role   text,
  request_id   text,
  subject_type text,                       -- 'village' | 'beneficiary' | …
  subject_id   text,
  payload      jsonb not null
)
```

`occurred_at` and `recorded_at` are both kept: they diverge when delivery is delayed, and a gap
between them is itself a signal worth being able to see.

`actor_email` is denormalised deliberately. An audit record that resolves the actor by foreign key
becomes unreadable the moment that user is removed — precisely when the record matters most.

### Append-only, enforced in the database

```sql
revoke update, delete on assam_floods.audit_log from service_role, authenticated, anon;
```

The API's own service-role connection must be unable to rewrite history. An audit log the
application can edit is not an audit log; it is a table the application happens to write to. This
also means audit rows survive a compromise of the API that stops short of database credentials.

### The writer is a subscriber, not a call site

An `AuditLogSubscriber` registers against the event bus in the composition root and writes each
event. No use case calls it, and no use case knows it exists. Adding a tenth bounded context gets
audit coverage for free, and — more importantly — a developer *cannot forget* to audit a new
operation, because the obligation was never theirs.

### Reporting

Admin and district-officer endpoints, filterable by actor, subject, event name and time range:

- `GET /audit` — paginated, filtered
- `GET /audit/subjects/:type/:id` — the full history of one village, beneficiary or project
- `GET /audit/actors/:id` — everything one user has done

The second of these is the one that matters to the product: *"show me everything that ever happened
to this village"* is the question a district officer actually asks, and answering it is why the
event stream was worth keeping.

### Payload capture and the before/after problem

Events carry their existing payloads verbatim. Where an event describes a mutation, it should
carry both sides — `village.severity-updated.v1` already does (`severity` + `previous`); others do
not, and making them do so is a change to the *emitting* use case, not to audit.

This is an honest gap rather than a solved problem: at first delivery the audit log will answer
"who changed this and when" completely, and "what exactly changed" only for events that already
happen to carry prior state. Retrofitting before/after across every mutating event is a larger
piece of work, and pretending otherwise in this ADR would set a false expectation for whoever
reads the audit UI and finds it thinner than they hoped.

### PII

Payloads may contain beneficiary names. The audit log inherits the beneficiary registry's
sensitivity and is readable only by `admin` and `district_officer` — never through any `/public/*`
route, and never by `anon`. Retention is unbounded for now; a records-retention policy is a
governance decision that needs a human owner, not a default I should quietly choose.

## Alternatives considered

**HTTP request logging (method, path, status, user).** Nearly free, and standard. Rejected as
insufficient: it records that a `POST /beneficiaries/b-1/aid` returned 201, not that aid was
recorded *and flagged as a probable duplicate of a district delivery five days earlier*. The
domain meaning — which is the whole point — lives in the event, not the request.

**Postgres triggers writing to an audit table.** Genuinely robust: impossible to bypass, catches
changes made outside the application, and needs no application cooperation. Rejected as the
*primary* mechanism because triggers see rows, not domain events — a trigger records that
`beneficiary_registry_duplicate_flags` gained a row, losing the concept "duplicate aid flagged"
and the actor, which exists only in application context. Worth adding later as a
belt-and-braces layer for out-of-band changes.

**Event sourcing (the log as the system of record).** The most complete answer, and the natural
end state of this design. Rejected as far too large a change now: it would mean rebuilding every
aggregate's persistence around replay. The current design keeps the option open, since a durable,
ordered, attributed event stream is exactly the substrate event sourcing needs.

**The existing `domain_events_outbox` table.** Already present and unused. Rejected for reuse
because an outbox and an audit log have opposed lifecycles — an outbox row is *deleted or marked
once delivered*, an audit row is immutable forever. Conflating them would put deletion pressure on
records that must never be deleted.

## Consequences

- Audit coverage is automatic and total for anything that emits an event, which is every state
  change in the platform. New contexts inherit it without doing anything.
- Every write incurs an extra insert. At pilot volumes this is irrelevant; at scale the subscriber
  should batch. It must **never** be made asynchronous-and-lossy — a dropped audit row is worse
  than a slow request.
- The log grows monotonically and holds PII, so retention and access review become real
  operational obligations, not hypothetical ones.
- "What changed" is only as good as the emitting events. Improving that is per-event work and
  should be prioritised by which subjects matter most — funds and beneficiaries before volunteers.
- Because `update` and `delete` are revoked, a genuinely bad audit row (say, PII written in error)
  cannot be edited away. That is the intended property, and it means care about what goes into
  payloads is required *before* the write, not after.
