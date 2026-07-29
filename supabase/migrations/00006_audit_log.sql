-- AFRIP audit trail (ADR 0011)
--
-- WHAT THIS TABLE IS
-- ---------------------------------------------------------------------------
-- One row per domain event. The platform already emits an event for every state
-- change (ADR 0005) and ADR 0010 stamps each with its actor; until now those
-- events went to an in-process bus and were discarded. This is where they land.
--
-- The cost of not having had it is written up in
-- docs/incidents/2026-07-28-id-collision-data-loss.md: a village record was
-- overwritten and could not be reconstructed, because the
-- `village.registered.v1` event that carried its name, district and severity had
-- been published to memory and thrown away. `domain_events_outbox` (00001) looks
-- like it should have helped and does not — it exists, it has never been written
-- to, and an outbox's lifecycle is the opposite of an audit log's anyway (a
-- delivered outbox row is deleted; an audit row is immutable forever). That is
-- why this is a new table rather than a reuse.
--
-- WHAT THE PRIVILEGES BELOW DO PROTECT AGAINST
-- ---------------------------------------------------------------------------
--   * The API rewriting its own history. The API connects with the SERVICE-ROLE
--     key, and `update`, `delete` and `truncate` are revoked from that role
--     below. A bug, a compromised handler, or a well-meant "clean up the test
--     rows" script running with the API's own credential cannot alter or remove
--     a row it has written. An audit log the application can edit is not an
--     audit log; it is a table the application happens to write to.
--   * A compromise of the API that stops short of database credentials. The
--     attacker can write new rows (they can also just perform actions, which
--     write rows); they cannot erase the ones describing what they did.
--   * The browser's publishable (anon) key reading beneficiary names. Payloads
--     are verbatim domain-event payloads and some of them name people, so this
--     table inherits the beneficiary registry's sensitivity. There is NO grant
--     to `authenticated` or `anon` here and no policy for them — see the note on
--     RLS below for why that combination, and not a policy, is the control.
--
-- WHAT IT DOES NOT PROTECT AGAINST — read this before calling it tamper-proof
-- ---------------------------------------------------------------------------
--   * Anyone holding the table OWNER's credential (`postgres`, the Supabase SQL
--     editor, a leaked database password). An owner can re-grant to itself and
--     then update or delete freely. That is deliberate and unavoidable: it is
--     also the only repair path for a row that must genuinely go (PII written in
--     error), and it lives outside the application by design — the same argument
--     00005 makes for `record_ownership`.
--   * Tampering DETECTION. There is no hash chain and no external attestation,
--     so an owner-level edit leaves no trace in this table. If that matters
--     later, the answer is a per-row hash over the previous row's hash, and it
--     is a separate migration.
--   * Rows that were never written. Nothing here makes the insert atomic with
--     the aggregate save it describes — the subscriber writes after the use case
--     has already committed, so a database outage loses the audit row while
--     keeping the data change. `packages/api/src/audit.ts` documents that
--     trade-off, what is logged so the row can be reconstructed by hand, and
--     what the real fix would be. A gap in this table is possible; it is not
--     silent.
--   * Bad content. Because `update` and `delete` are revoked, a payload
--     containing PII written in error cannot be edited away through the
--     application. Care about what goes into a payload is required BEFORE the
--     write. That is the intended property, not an oversight.
--
-- WHY RLS IS ENABLED THOUGH NOTHING READS THROUGH IT
-- ---------------------------------------------------------------------------
-- Same shape as 00005, one step stricter. service_role bypasses RLS by design,
-- so policies are invisible to the API and authorization for `GET /audit*` is
-- enforced in the application layer (`admin` and `district_officer` only,
-- ADR 0011 §PII). The other door — a signed-in publishable key pointed straight
-- at `/rest/v1` — is closed here not by a policy but by the absence of any
-- grant at all: `authenticated` cannot reach the table, so there are no rows for
-- a policy to filter. RLS is switched on anyway so that a future `grant select`
-- added by someone in a hurry fails closed (no policy = no rows) instead of
-- exposing the whole log.
--
-- Everything lives in `assam_floods`. See 00001 for why the project's `public`
-- schema is off limits — the Supabase project is shared with four unrelated
-- applications. A custom schema starts with NO grants at all, not even for
-- service_role, so the grant below is spelled out where `public` would have
-- implied it (the point 00002, 00004 and 00005 each make in turn).
--
-- Idempotent throughout: `if not exists` on the table and the indexes, and
-- grant/revoke are naturally repeatable. Re-running this file is a no-op.

-- ---------------------------------------------------------------------------
-- The log
-- ---------------------------------------------------------------------------
-- Columns are ADR 0011 §Storage verbatim. Two of them are worth restating,
-- because both look redundant and neither is:
--
-- `occurred_at` AND `recorded_at`. The first is the instant the domain event
-- says it happened, the second is when this row was written. They diverge when
-- delivery is delayed, and the size of the gap is itself a signal — a batch of
-- rows recorded minutes after they occurred says something happened to the
-- writer that no single row would reveal.
--
-- `actor_email` is DENORMALISED on purpose. An audit record that resolves its
-- actor through a foreign key becomes unreadable the moment that user is
-- deleted, which is precisely the moment the record matters most. The same
-- reasoning explains why `actor_id` is a bare uuid and not a reference into
-- `auth.users`: that schema is Supabase-managed (00004 makes the argument), and
-- a row here must survive the disappearance of the account it names.
--
-- `actor_role` carries more than a role. A `user` actor puts its application
-- role here verbatim ('admin', 'district_officer'); a `system` actor puts
-- 'system:<process>' and an `anonymous` one 'anonymous:<via>'. The union in
-- `packages/shared-kernel/src/events.ts` keeps those three cases apart because
-- "a person we cannot name did this" and "no person did this" are different
-- facts, and flattening both to NULL would lose the distinction the audit log
-- exists to preserve. NULL here therefore means a fourth thing — nobody stamped
-- this event at all — and `packages/api/src/audit.ts` documents the encoding.
--
-- `subject_type` / `subject_id` are nullable and text. Nullable because an event
-- whose name we do not recognise must still be recorded (dropping the row is the
-- one outcome an audit log may never have); text and un-keyed because the
-- referent is one of ten tables and a polymorphic foreign key is not expressible
-- in Postgres — the same trade-off 00005 takes for `record_ownership.record_id`.
--
-- `payload` is the domain event's payload verbatim, jsonb rather than json so it
-- can be indexed and queried later without a rewrite.
create table if not exists assam_floods.audit_log (
  id bigint generated always as identity primary key,
  event_name text not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  actor_role text,
  request_id text,
  subject_type text,
  subject_id text,
  payload jsonb not null
);

-- ---------------------------------------------------------------------------
-- The three indexes are the three reporting endpoints, one each
-- ---------------------------------------------------------------------------
-- `GET /audit/subjects/:type/:id` — "show me everything that ever happened to
-- this village". ADR 0011 calls this the query that matters to the product, and
-- it is the reason the event stream was worth keeping. Composite and in this
-- order because `subject_type` alone is never asked for.
create index if not exists audit_log_subject
  on assam_floods.audit_log (subject_type, subject_id);

-- `GET /audit/actors/:id` — "everything one user has done". Rows with a null
-- actor_id (system, anonymous, unstamped) are still indexed; Postgres btrees
-- index NULLs, so "which events had no named actor" is served too.
create index if not exists audit_log_actor
  on assam_floods.audit_log (actor_id);

-- `GET /audit` — the paginated, time-filtered listing. Descending because every
-- caller wants the recent end first, and a descending index serves the
-- `occurred_at >= ? and occurred_at <= ?` range filter as well.
--
-- Note what this index is NOT for: paging. `packages/api/src/audit.ts` pages by
-- keyset on `id`, served by the primary key, because `occurred_at` is neither
-- unique nor monotonic with insertion order — see the note above about the two
-- timestamps diverging.
create index if not exists audit_log_occurred_at
  on assam_floods.audit_log (occurred_at desc);

alter table assam_floods.audit_log enable row level security;

-- ---------------------------------------------------------------------------
-- Grants: the API writes and reads, nobody else touches it
-- ---------------------------------------------------------------------------
-- Defensive rather than corrective — a custom schema grants nothing by default,
-- so neither role has ever held a privilege here. It is spelled out so the
-- intent is legible: the browser must not reach this table, and adding a grant
-- to `authenticated` should look like the deliberate change it would be.
revoke all on assam_floods.audit_log from public, anon, authenticated;

-- `select` and `insert` and nothing else. Contrast 00005, which grants `all` to
-- service_role and then revokes the dangerous half; here the narrow grant is the
-- primary statement of intent and the revoke below is the backstop that survives
-- a replay.
grant select, insert on assam_floods.audit_log to service_role;

-- ---------------------------------------------------------------------------
-- Append-only, for EVERY role including service_role
-- ---------------------------------------------------------------------------
-- ADR 0011 is explicit: "The API's own service-role connection must be unable to
-- rewrite history."
--
-- TRUNCATE goes with UPDATE and DELETE, and the ADR's own snippet omits it. It
-- is the same operation in bulk — one statement that empties the entire audit
-- trail — and leaving it granted would make this whole section decorative.
--
-- REFERENCES and TRIGGER go with them, which the ADR does not mention either.
-- Neither can rewrite a row on its own, so this is tidiness rather than defence:
-- without them the catalogue shows service_role holding exactly `INSERT, SELECT`
-- on this table, which is what the grant above claims and what an auditor
-- reading `information_schema.role_table_grants` should see. Leaving two stray
-- privileges behind would make the claim approximately true, and "approximately"
-- is not a useful property of an access-control statement.
--
-- Ordering note, the same one 00005 carries: 00002 ends with `grant all on all
-- tables in schema assam_floods to service_role`. On a re-run of the whole
-- migration set that statement re-grants ALL of these on this table (it exists
-- by then) before this file runs again. That is why the revoke is a separate
-- statement here, after the grant, rather than being expressed only as the
-- narrow grant above — it re-asserts on every replay. Verified by applying
-- 00001→00006 twice against a local Postgres 16 and checking the catalogue and
-- the refusals afterwards, not by reading.
revoke update, delete, truncate, references, trigger on assam_floods.audit_log
  from public, anon, authenticated, service_role;

-- No policy is created, and the omission is the control rather than an oversight
-- (00002 makes the same argument for its tables with RLS on and no policy). RLS
-- with no policy denies every non-bypassing role outright, which is the
-- strictest posture available; adding a policy could only loosen it.
