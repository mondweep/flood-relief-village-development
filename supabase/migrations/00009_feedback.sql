-- AFRIP in-app feedback (ADR 0016)
--
-- WHAT THIS TABLE IS
-- ---------------------------------------------------------------------------
-- One row per report filed from inside the application by a signed-in user: a
-- bug, a feature request, or something else. Version 1 shipped with no route at
-- all for the people who will find its faults — no address in the page, no form,
-- no issue tracker a field worker in Nazira could reach — so a report either
-- travelled by word of mouth or was lost. This is where it lands instead.
--
-- Each row carries the context the user should not have to type: the build
-- commit and branch the page was serving, the view they were on, and their user
-- agent. ADR 0016 §"Context is captured, location is not" is explicit about what
-- is deliberately NOT here: no geolocation, no IP, no identifier beyond the
-- account already signed in. A bug report is not a reason to learn where a field
-- worker is standing.
--
-- THIS TABLE HOLDS FREE TEXT AND FREE TEXT HERE WILL CONTAIN PERSONAL DATA
-- ---------------------------------------------------------------------------
-- Read this before deciding it is low-value operational chatter. A useful bug
-- report reads "the aid record for Rekha Das in Nazira shows twice" — exactly
-- the report we want, and exactly the sensitivity of the beneficiary registry
-- (ADR 0009). The submission form carries a visible line asking users not to
-- type names, which ADR 0016 is careful to call a nudge and not a control.
--
-- That is why the read side is NARROWER than the audit log's. ADR 0011 lets
-- `admin` and `district_officer` read `audit_log`; ADR 0016 §"Administrators
-- only" admits `admin` alone here. The audit log's payloads are domain events
-- with known, structured fields; this is unbounded prose written by somebody who
-- has not been told what not to include, and the reader set for free-text PII
-- should be the smallest set that can act on it.
--
-- HOW THIS DIFFERS FROM 00006, AND WHY — THE ONE PARAGRAPH TO READ
-- ---------------------------------------------------------------------------
-- `audit_log` is APPEND-ONLY: 00006 revokes `update` and `delete` from every
-- role including service_role, so the API cannot rewrite its own history. THIS
-- TABLE IS NOT APPEND-ONLY. `update` is granted to service_role below, on
-- purpose, because `status` has to move — an administrator marks a report
-- acknowledged, resolved or declined (ADR 0016 §Status).
--
-- The two are different because the rows mean different things. An audit row is
-- a statement about the past: "this happened, at this instant, by this actor". A
-- statement about the past is not amendable — amending it does not correct
-- history, it rewrites it, and a log the application can edit is not a log. A
-- feedback row is a LIVE WORK ITEM: it describes a report that is currently open
-- and whose state genuinely changes as somebody deals with it. Freezing `status`
-- would not protect any historical fact; it would only mean the table could
-- never say which reports had been dealt with, which is the one thing the column
-- exists for.
--
-- The narrowness of that exception is the point. `update` is granted, not `all`,
-- and the API's only update path sets `status` and nothing else
-- (`packages/api/src/feedback.ts`). The grant does not stop a bug in this API
-- from rewriting a user's `summary` — no privilege here can, because the same
-- role must be able to move `status` — so that guarantee is carried by the
-- application and by the absence of any route that would do it, not by SQL.
-- Stated plainly so nobody mistakes this for the audit log's stronger promise.
--
-- WHAT THE PRIVILEGES BELOW DO PROTECT AGAINST
-- ---------------------------------------------------------------------------
--   * The browser's publishable (anon) key reading other people's reports.
--     There is NO grant to `authenticated` or `anon` here and no policy for
--     them — see the note on RLS below for why that combination, and not a
--     policy, is the control. This matters more than for most tables: a report
--     is free text about a named beneficiary often enough that a leak here is a
--     leak of the registry by another route.
--   * The API deleting reports. `delete` and `truncate` are revoked from
--     service_role below. The application has no delete endpoint, so a delete
--     privilege could only ever be exercised by a bug, a compromised handler, or
--     a "clean up the test rows" script running with the API's own credential —
--     and a feedback queue that the software under complaint can empty is not a
--     feedback queue.
--   * Reports being filed under somebody else's name. Nothing in SQL enforces
--     this — see below.
--
-- WHAT IT DOES NOT PROTECT AGAINST — read this before relying on it
-- ---------------------------------------------------------------------------
--   * Anyone holding the table OWNER's credential (`postgres`, the Supabase SQL
--     editor, a leaked database password). An owner can re-grant to itself and
--     then update or delete freely. That is deliberate and unavoidable, and it
--     is also the only repair path for a row that must genuinely go — a report
--     naming a beneficiary that should never have been written. It lives outside
--     the application by design, the same argument 00005 and 00006 make.
--   * The reporter columns being truthful. `reporter_id`, `reporter_email` and
--     `reporter_role` are written by the API from the verified actor on the
--     request (ADR 0016; `packages/api/src/routes/feedback.ts` takes them from
--     `ctx.actor` and NEVER from the request body, and a route test asserts it).
--     Postgres cannot check that: service_role may write any value it likes into
--     these columns, so the guarantee that a report is filed by the person it
--     names is an application guarantee, held up by that test and by nothing
--     here.
--   * Length. Both text columns are unbounded — see the note on the columns.
--   * Volume. Nothing here rate-limits a signed-in user filing ten thousand
--     reports. ADR 0016 refuses ANONYMOUS submission partly for this reason (an
--     unauthenticated write endpoint with no captcha and no moderation queue is
--     a spam sink), which reduces the problem to an accountable one — every row
--     names who wrote it — without removing it. A rate limit is the honest fix
--     and it is not in this migration.
--
-- WHY RLS IS ENABLED THOUGH NOTHING READS THROUGH IT
-- ---------------------------------------------------------------------------
-- Same shape as 00006. service_role bypasses RLS by design, so policies are
-- invisible to the API and authorization for `/feedback` is enforced in the
-- application layer (`admin` alone on the read and status-change routes,
-- ADR 0016). The other door — a signed-in publishable key pointed straight at
-- `/rest/v1` — is closed here not by a policy but by the absence of any grant at
-- all: `authenticated` cannot reach the table, so there are no rows for a policy
-- to filter. RLS is switched on anyway so that a future `grant select` added by
-- someone in a hurry fails closed (no policy = no rows) instead of exposing
-- every report on the platform.
--
-- A policy letting a user read their OWN reports back was considered and is
-- deliberately absent: nothing in the product shows a user their submissions,
-- so the policy would grant a read that no caller makes, and the way that fails
-- is that `authenticated` gains a grant on this table for a feature nobody
-- built. Add it with the feature, not before.
--
-- Everything lives in `assam_floods`. See 00001 for why the project's `public`
-- schema is off limits — the Supabase project is shared with four unrelated
-- applications. A custom schema starts with NO grants at all, not even for
-- service_role, so the grant below is spelled out where `public` would have
-- implied it (the point 00002, 00004, 00005 and 00006 each make in turn).
--
-- Idempotent throughout: `if not exists` on the table and the indexes, and
-- grant/revoke are naturally repeatable. Re-running this file is a no-op.

-- ---------------------------------------------------------------------------
-- The reports
-- ---------------------------------------------------------------------------
-- Columns are ADR 0016 §Storage verbatim. Four points are worth restating:
--
-- `id` is TEXT, not the `bigint generated always as identity` 00006 uses. It is
-- assigned by the API (`feedback-<uuid4>`, via the same `RandomIdGenerator`
-- every other AFRIP id comes from) for consistency with the nine contexts'
-- tables above, all of which are `id text primary key`. The consequence for
-- paging is real and is handled in `packages/api/src/feedback.ts`: a random id
-- carries no order, so pages are keyed on `(created_at, id)` rather than on the
-- id alone, and the index below exists for exactly that.
--
-- `reporter_email` and `reporter_role` are DENORMALISED, for the same reason
-- 00006 gives for `actor_email`: a report that resolves its reporter through a
-- foreign key becomes unreadable the moment that account is deleted, which on a
-- report still being worked is precisely when the reader needs to know who to go
-- back to. `reporter_id` is likewise a bare uuid and not a reference into
-- `auth.users` — that schema is Supabase-managed (00004 makes the argument) and
-- a row here must survive the disappearance of the account it names.
--
-- All three reporter columns are NULLABLE even though ADR 0016 refuses
-- anonymous submission. The refusal is enforced at the API boundary, where the
-- actor is known; `not null` here would be a second, weaker copy of that rule
-- (it would still admit `reporter_id = <any uuid>`), and it would make the
-- column unable to record the one honest case for a null — a row inserted by a
-- future migration or a hand repair that genuinely has no reporter. The route
-- test `refuses an anonymous submission` is the control; this is storage.
--
-- `summary` and `detail` are UNBOUNDED text, and the length caps live in the
-- API (`MAX_SUMMARY_LENGTH` / `MAX_DETAIL_LENGTH` in
-- `packages/api/src/feedback.ts`, enforced with a 400 at the boundary). That is
-- a deliberate split and not an omission. ADR 0016 §Storage fixes these columns
-- as plain `text`, and service_role is the ONLY role that can write here, so the
-- API boundary is the only door a row can come through — a check constraint
-- would be a second statement of the same limit that a later product decision
-- ("allow longer bug reports") must remember to change in two places, with a
-- migration required to do it. What is given up is the backstop: if a future
-- writer reaches this table without going through that boundary, nothing here
-- will stop an unbounded insert. If a second writer is ever added, add the
-- constraint with it.
create table if not exists assam_floods.feedback (
  id text primary key,
  kind text not null check (kind in ('bug', 'feature', 'other')),
  summary text not null,
  detail text,
  -- Context, captured automatically. The user types none of this.
  build_commit text,
  build_branch text,
  view_path text,
  user_agent text,
  -- Who, denormalised for the same reason as audit_log (ADR 0011)
  reporter_id uuid,
  reporter_email text,
  reporter_role text,
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'declined')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Two indexes, and the one that is deliberately absent
-- ---------------------------------------------------------------------------
-- `GET /feedback` — the administrator's list, newest first. Composite and in
-- this order because it is BOTH the sort and the paging key: ids here are random
-- (see above), so `packages/api/src/feedback.ts` pages by keyset on
-- `(created_at, id)` and needs the tiebreaker in the index to make the page
-- boundary deterministic. Descending on both, matching the query.
create index if not exists feedback_created_at
  on assam_floods.feedback (created_at desc, id desc);

-- `GET /feedback?status=open` — the triage query, which is the one an
-- administrator actually runs: this platform has no notification, so somebody
-- has to come and look, and what they look for is what is still open.
create index if not exists feedback_status
  on assam_floods.feedback (status, created_at desc);

-- NO INDEX ON `kind`, though the endpoint filters on it. Three values across a
-- table this size means the filter discards at most two thirds of a sequential
-- scan the ordering index already serves, and an index Postgres declines to use
-- is not free — it is written on every insert and it misleads the next reader
-- about which queries matter. Add one when the volume argues for it.

alter table assam_floods.feedback enable row level security;

-- ---------------------------------------------------------------------------
-- Grants: the API writes, reads and moves the status; nobody else touches it
-- ---------------------------------------------------------------------------
-- Defensive rather than corrective — a custom schema grants nothing by default,
-- so neither role has ever held a privilege here. It is spelled out so the
-- intent is legible: the browser must not reach this table, and adding a grant
-- to `authenticated` should look like the deliberate change it would be.
revoke all on assam_floods.feedback from public, anon, authenticated;

-- `select`, `insert`, `update` and nothing else. The `update` is the whole
-- difference from 00006 and the header above argues it: `status` is a live
-- field on a live work item, not a historical fact.
grant select, insert, update on assam_floods.feedback to service_role;

-- ---------------------------------------------------------------------------
-- Nothing may be removed, by any role including service_role
-- ---------------------------------------------------------------------------
-- `declined` is how a report is closed. Deleting it is how a report disappears,
-- and a queue that the software being complained about can empty is worth
-- nothing to the person who filed into it.
--
-- TRUNCATE goes with DELETE: it is the same operation in bulk — one statement
-- that empties every report ever filed — and leaving it granted would make this
-- section decorative. That is the same argument 00006 makes, and it is the half
-- of 00006's posture that DOES carry over.
--
-- REFERENCES and TRIGGER go with them. Neither can rewrite a row on its own, so
-- this is tidiness rather than defence: without them the catalogue shows
-- service_role holding exactly `INSERT, SELECT, UPDATE` on this table, which is
-- what the grant above claims and what an auditor reading
-- `information_schema.role_table_grants` should see. Leaving two stray
-- privileges behind would make the claim approximately true, and "approximately"
-- is not a useful property of an access-control statement.
--
-- Ordering note, the same one 00005 and 00006 carry: 00002 ends with `grant all
-- on all tables in schema assam_floods to service_role`. On a re-run of the
-- whole migration set that statement re-grants ALL of these on this table (it
-- exists by then) before this file runs again. That is why the revoke is a
-- separate statement here, after the grant, rather than being expressed only as
-- the narrow grant above — it re-asserts on every replay. Verified by applying
-- 00001→00009 twice against a local Postgres 16 and reading the catalogue
-- afterwards, not by reasoning about it.
revoke delete, truncate, references, trigger on assam_floods.feedback
  from public, anon, authenticated, service_role;

-- No policy is created, and the omission is the control rather than an oversight
-- (00002 and 00006 make the same argument). RLS with no policy denies every
-- non-bypassing role outright, which is the strictest posture available; adding
-- a policy could only loosen it.
