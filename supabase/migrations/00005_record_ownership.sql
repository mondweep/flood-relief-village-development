-- AFRIP record ownership (ADR 0009)
--
-- WHAT RLS IS DOING HERE, AND WHAT IT IS NOT
-- ---------------------------------------------------------------------------
-- Read this before treating anything below as an access control.
--
-- The API connects with the SERVICE-ROLE key, and service_role bypasses RLS by
-- design. Every policy in this file is therefore invisible to the application:
-- it is the SECOND line, not the mechanism. Authorization is enforced in the
-- application layer, at the use-case boundary (ADR 0009), and a bug there is a
-- bug these policies will not catch — the query that bug produces arrives with
-- RLS already bypassed.
--
-- What the policies DO protect against is the other door: the browser holds a
-- publishable (anon) key so it can talk to GoTrue (ADR 0008, `GET /public/config`),
-- and that same key reaches PostgREST. So the threat these policies answer is
-- "someone points a signed-in publishable key at /rest/v1 directly", plus the
-- leaked-key case. That is worth defending and it is all this defends.
--
-- Everything lives in `assam_floods` (see 00001 for why the project's `public`
-- schema is off limits — the Supabase project is shared with four unrelated
-- applications). A custom schema starts with NO grants at all, not even for
-- service_role, so grants below are spelled out where `public` would have
-- implied them (the same point 00002 and 00004 make).
--
-- Idempotent throughout: `if not exists`, `create or replace`, and policies
-- dropped before being recreated (Postgres has no `create policy if not
-- exists`). Re-running this file is a no-op.

-- ---------------------------------------------------------------------------
-- The ownership table
-- ---------------------------------------------------------------------------
-- One row per created record, rather than a `created_by` column on twenty-three
-- tables. ADR 0009 argues the trade-off in full; the short version is that
-- `Village` and `Beneficiary` have no business knowing that users exist, and a
-- column would push that concept into nine bounded contexts.
--
-- `record_type` mirrors OWNABLE_RECORD_TYPES in
-- `packages/shared-kernel/src/authorization.ts`. Adding a type means changing
-- both, and this constraint is the one that will catch you: a type added in
-- TypeScript and not here produces an insert Postgres refuses.
--
-- `record_id` is text, not a foreign key. There is no single table to point at
-- — the referent is one of five — and a polymorphic FK is not expressible in
-- Postgres. The cost is that this table can hold a row for a record that no
-- longer exists; the mitigation is that nothing here is deletable, so a stale
-- row is inert rather than dangerous.
--
-- `owner_id` is `auth.users.id`, deliberately NOT declared as a foreign key
-- into `auth` — same judgement as `user_profiles.id` in 00004: `auth` is
-- Supabase-managed, and a FK into it makes this schema undroppable
-- independently and couples our migrations to theirs.
create table if not exists assam_floods.record_ownership (
  record_type text not null
    check (record_type in ('village', 'issue', 'volunteer', 'plan', 'signal')),
  record_id text not null,
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (record_type, record_id)
);

-- The primary key serves `isOwner` (the hot path: exact record_type +
-- record_id). This index serves the query that is obviously next — "everything
-- I created" — which the PK's leading column cannot answer.
create index if not exists record_ownership_owner
  on assam_floods.record_ownership (owner_id);

alter table assam_floods.record_ownership enable row level security;

grant all on assam_floods.record_ownership to service_role;

-- Reaches the table; the policy below decides which rows come back.
grant select on assam_floods.record_ownership to authenticated;

-- A user may read the ownership rows that name them, and nothing else. Note
-- what is ABSENT: no insert, update or delete policy and no write grant to
-- `authenticated`, so a client holding a publishable key cannot claim ownership
-- of a record it did not create. Ownership is written by the API (as
-- service_role) at the moment a creating use case succeeds, and nowhere else.
drop policy if exists "read own ownership" on assam_floods.record_ownership;
create policy "read own ownership" on assam_floods.record_ownership
  for select to authenticated
  using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Ownership is append-only, for EVERY role including service_role
-- ---------------------------------------------------------------------------
-- This is the deliberate part, and it has a cost worth stating out loud rather
-- than discovering later.
--
-- A row here asserts a historical fact: this account created this record. A
-- fact is not amendable — "reassigning" ownership does not correct history, it
-- rewrites it, and on a platform whose entire purpose is that records of who
-- did what cannot quietly change, a table recording authorship that authorship
-- itself can edit would be self-defeating. `record` in the adapter is
-- first-writer-wins for the same reason: a replayed creation event must not
-- move an owner.
--
-- THE COST: an owner recorded wrongly (a bad `sub`, a mis-wired decorator)
-- cannot be corrected through the application or through the API's own
-- credentials. An administrator who genuinely needs to fix one must do it as a
-- superuser at the SQL console — a privilege escalation that leaves a trace in
-- the Postgres logs and cannot be reached from a leaked key. That is the point:
-- the repair path exists, and it is deliberately not the application's.
--
-- TRUNCATE goes with UPDATE and DELETE. It is the same operation in bulk, and
-- leaving it granted would make the paragraph above decorative.
--
-- Ordering note: 00002 ends with `grant all on all tables in schema
-- assam_floods to service_role`, which on a re-run of the whole migration set
-- re-grants update/delete on this table before this file runs again. That is
-- why the revoke lives here, after the grant, rather than being expressed as a
-- narrower grant above — it re-asserts on every replay.
revoke update, delete, truncate on assam_floods.record_ownership
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tightening the 00002 policies to match the role model
-- ---------------------------------------------------------------------------
-- ADR 0009 §"RLS as defence in depth" calls for the 00002-era policies to be
-- brought in line with the role model now that ADR 0008 issues real identities.
-- What follows is that, and only that — the seven policies below said
-- `using (true)`, meaning "any authenticated user of this Supabase project".
--
-- On a project AFRIP owned alone, `using (true)` would be defensible. It is not
-- defensible here, and 00004's boxed note says why: `auth.users` is
-- project-wide, so a signup for one of the four neighbouring applications
-- becomes an AFRIP `citizen`, and `citizen` under `using (true)` reads AFRIP's
-- village, damage, NGO, assignment, fund, issue and recovery tables directly
-- with a publishable key. That is option (1) in 00004's list of ways out —
-- "enforce roles so `citizen` is a floor rather than a skeleton key" — applied
-- to the RLS half of the problem.
--
-- What is NOT attempted here, deliberately: per-village and per-NGO scoping.
-- ADR 0009 says a district officer reads all villages, an NGO coordinator reads
-- their assigned villages, a village committee member reads their own. Only the
-- first of those is expressible today — `user_profiles` (00004) has no
-- `village_id` or `ngo_id` column, so there is nothing to join a coordinator to
-- their assignment. Inventing that linkage here would be guessing at a data
-- model that belongs in its own migration, and the application layer is where
-- the scoping is actually enforced anyway. The tightening below is therefore
-- coarse on purpose: it separates AFRIP staff from everyone else, and stops.

-- The caller's application role, or null if they are not an AFRIP user at all.
--
-- Reads `user_profiles`, never the JWT. A user controls their own signup
-- payload, so a role carried by a token is a role the user chose for themselves
-- — the point 00004's header makes at length and the reason `role` lives in a
-- table the API writes and the user cannot.
--
-- SECURITY DEFINER so the answer does not depend on the "read own profile"
-- policy continuing to exist, with `search_path` pinned so the function cannot
-- be redirected by a caller's search_path (the standard hardening, as in
-- 00004's `sync_user_profile`). It discloses nothing: it can only ever report
-- the calling user's own role.
--
-- plpgsql rather than sql so `auth.uid()` is resolved at call time, keeping the
-- function creatable on a plain Postgres that has no `auth` schema.
create or replace function assam_floods.actor_role()
returns text
language plpgsql
stable
security definer
set search_path = assam_floods, pg_catalog
as $$
declare
  found_role text;
begin
  select p.role into found_role
  from assam_floods.user_profiles p
  where p.id = auth.uid();

  return found_role;
end;
$$;

-- True for the four roles that operate the platform; false for `citizen` and
-- for anyone with no AFRIP profile. `citizen` is not staff by design — ADR 0009
-- gives that role the public projection and the right to report issues, both of
-- which are served by the API, neither of which needs a raw table.
create or replace function assam_floods.actor_is_staff()
returns boolean
language sql
stable
as $$
  select assam_floods.actor_role()
    in ('admin', 'district_officer', 'ngo_coordinator', 'village_committee');
$$;

-- Policies evaluate as the CALLING role, so the caller needs execute. Revoked
-- from public first: a definer function left executable by public is the
-- classic way one stops being a control.
revoke all on function assam_floods.actor_role() from public;
revoke all on function assam_floods.actor_is_staff() from public;
grant execute on function assam_floods.actor_role() to authenticated, service_role;
grant execute on function assam_floods.actor_is_staff() to authenticated, service_role;

-- The seven `using (true)` policies from 00002, restated. Names and grants are
-- unchanged, so this is a narrowing of existing policies rather than a new
-- surface: every one of these tables was already readable by `authenticated`
-- and now requires an AFRIP staff role as well.
drop policy if exists "authenticated read villages" on assam_floods.village_registry_villages;
create policy "authenticated read villages" on assam_floods.village_registry_villages
  for select to authenticated using (assam_floods.actor_is_staff());

drop policy if exists "authenticated read damage" on assam_floods.village_registry_damage_assessments;
create policy "authenticated read damage" on assam_floods.village_registry_damage_assessments
  for select to authenticated using (assam_floods.actor_is_staff());

drop policy if exists "authenticated read ngos" on assam_floods.ngo_coordination_ngos;
create policy "authenticated read ngos" on assam_floods.ngo_coordination_ngos
  for select to authenticated using (assam_floods.actor_is_staff());

drop policy if exists "authenticated read assignments" on assam_floods.ngo_coordination_assignments;
create policy "authenticated read assignments" on assam_floods.ngo_coordination_assignments
  for select to authenticated using (assam_floods.actor_is_staff());

drop policy if exists "authenticated read projects" on assam_floods.fund_monitoring_projects;
create policy "authenticated read projects" on assam_floods.fund_monitoring_projects
  for select to authenticated using (assam_floods.actor_is_staff());

drop policy if exists "authenticated read issues" on assam_floods.issue_tracking_issues;
create policy "authenticated read issues" on assam_floods.issue_tracking_issues
  for select to authenticated using (assam_floods.actor_is_staff());

drop policy if exists "authenticated read indices" on assam_floods.recovery_intelligence_indices;
create policy "authenticated read indices" on assam_floods.recovery_intelligence_indices
  for select to authenticated using (assam_floods.actor_is_staff());

-- Beneficiary rows are the sharpest rule in the PRD — a citizen must see none
-- of the registry — and 00002 already scoped them to an NGO. What is added is
-- the conjunct, not the scope: the 00002 policy rested ENTIRELY on
-- `auth.jwt() ->> 'ngo_id'`, and a JWT claim is not a control the API owns.
-- Today nothing populates that claim so the policy denies everyone by accident;
-- the day someone adds an access-token hook (or copies signup metadata into the
-- token, which the user writes), it would start granting beneficiary reads to
-- whoever asked. Requiring an `ngo_coordinator` profile alongside the claim
-- makes the table's own role a precondition rather than the token's.
--
-- The unchanged half — matching `ngo_id` against the village's ACTIVE
-- assignment — stays exactly as 00002 wrote it, including the `coalesce` that
-- makes a missing claim fail closed.
drop policy if exists "ngo-scoped read beneficiaries" on assam_floods.beneficiary_registry_beneficiaries;
create policy "ngo-scoped read beneficiaries" on assam_floods.beneficiary_registry_beneficiaries
  for select to authenticated
  using (
    assam_floods.actor_role() = 'ngo_coordinator'
    and exists (
      select 1 from assam_floods.ngo_coordination_assignments a
      where a.village_id = assam_floods.beneficiary_registry_beneficiaries.village_id
        and a.status = 'active'
        and a.ngo_id = coalesce(auth.jwt() ->> 'ngo_id', '')
    )
  );

-- Left alone, and worth saying so rather than leaving the omission ambiguous:
--
--   * `public_village_recovery` / `public_fund_transparency` keep their `anon`
--     grant. They ARE the citizen's projection, they carry no personal data by
--     construction, and the dashboard that reads them is unauthenticated. They
--     are deliberately not granted to `authenticated` as well: nothing in this
--     codebase reads PostgREST from the browser (the page talks to `/auth/v1`
--     for sign-in and to the API for everything else), so the grant would widen
--     the surface to serve no caller.
--   * `role_grants` and `user_profiles` (00004) are already right — the first
--     has no policy at all, the second reads own-row-only.
--   * The tables with RLS enabled and no policy (expenditures, anomalies,
--     aid records, follow-ups, duplicate flags, volunteers, plans, goals,
--     milestones, signals, alerts, outbox, history) deny `authenticated`
--     outright, which is already the strictest posture available. Adding
--     policies to them would loosen, not tighten.
