-- ---------------------------------------------------------------------------
-- 00010 — where a role came from, so that some admins can appoint others
-- ---------------------------------------------------------------------------
--
-- WHY THIS EXISTS.
--
-- Until now the platform had exactly one administrator, because the only way to
-- become one was a row in `role_grants` (00004) and the only way to add a row
-- there is a migration and a deploy. That is auditable and it does not scale:
-- every appointment blocks on the one person who can deploy.
--
-- The obvious fix — let any admin appoint any admin — is refused. `admin` on
-- this platform is not a role with more permissions; it is a role that is NOT
-- CHECKED (`authorizePlatform` admits it before consulting the policy table).
-- So an admin holds the beneficiary register, the audit trail and the feedback
-- queue outright. Handing out an unchecked credential with no in-app way to take
-- it back is a decision one mistake cannot be undone from.
--
-- So roles gain PROVENANCE, and the provenance decides who may appoint:
--
--   'grant'     the role was asserted by `role_grants` — i.e. by a migration, in
--               version control, reviewed. An `admin` whose role_source is
--               'grant' is a SUPER ADMIN: they, and only they, may change other
--               people's roles.
--   'appointed' the role was set in-app by a super admin. An `admin` appointed
--               this way can do everything an administrator does EXCEPT change
--               roles, so the set of people who can hand out unchecked access
--               stays exactly the set named in this repository.
--   'self'      nobody assigned it. This is the `citizen` floor everyone lands
--               on by self-registering.
--
-- The property being preserved is the one 00004 already leans on and states:
-- "the grant is reviewable in version control rather than being a click somebody
-- made in a dashboard once". Appointment becomes a click; *who may click* does
-- not.
--
-- WHAT THIS DOES NOT DO. It does not add a `super_admin` role. That would ripple
-- through `USER_ROLES`, the policy table, this file's own CHECK constraint and
-- every role-related test, to express something a column already expresses. The
-- role set is unchanged: five roles, exactly as ADR 0009 defines them.

-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------
-- `not null default 'self'` is safe for the backfill: every existing row either
-- matches a grant (corrected immediately below) or is a self-registration, which
-- is what the default says.
alter table assam_floods.user_profiles
  add column if not exists role_source text not null default 'self';

-- Idempotent: `add constraint if not exists` does not exist in PostgreSQL, so the
-- constraint is dropped and recreated. Re-running the migration must not fail,
-- and `scripts/check-migrations.sh` applies the whole set twice to prove it.
alter table assam_floods.user_profiles
  drop constraint if exists user_profiles_role_source_check;
alter table assam_floods.user_profiles
  add constraint user_profiles_role_source_check
  check (role_source in ('grant', 'appointed', 'self'));

comment on column assam_floods.user_profiles.role_source is
  'Where this role came from: grant (role_grants, i.e. version control — an admin '
  'with this source is a super admin and may change other roles), appointed (set '
  'in-app by a super admin), self (the citizen floor from self-registration).';

-- ---------------------------------------------------------------------------
-- Backfill, and re-assertion on every replay
-- ---------------------------------------------------------------------------
-- Anyone whose current role matches a grant HAS that role because of the grant.
-- Written as a plain idempotent update, matching the one at the end of 00004, so
-- that re-running the migration re-asserts the intended state rather than
-- assuming nothing has drifted.
--
-- `p.role = g.role` and not merely an email match: if a super admin has since
-- been appointed something else in-app, the grant no longer describes them and
-- claiming otherwise would silently restore powers somebody deliberately removed.
-- (The API refuses that particular change — see below — but this file must be
-- correct on its own, because a migration is what runs when the API is wrong.)
update assam_floods.user_profiles p
set role_source = 'grant'
from assam_floods.role_grants g
where lower(p.email) = lower(g.email)
  and p.role = g.role
  and p.role_source is distinct from 'grant';

-- ---------------------------------------------------------------------------
-- Enrolment sets the provenance too
-- ---------------------------------------------------------------------------
-- Replaces the 00004 function. Same signature, same `#variable_conflict` note,
-- same OUT-parameter shape — the one change is that it now records WHERE the
-- role came from, so a person who registers after their grant was written is
-- indistinguishable from one who registered before it.
--
-- `#variable_conflict use_column` is REQUIRED and not stylistic: the OUT
-- parameters are named `id`, `email` and `role`, which collide with the columns
-- of every table this function touches. Without it PL/pgSQL resolves those
-- identifiers to the parameters and the function silently reads nulls.
--
-- THE INPUT PARAMETER NAMES MUST STAY `p_user_id` AND `p_email`. PostgreSQL
-- refuses `create or replace` when an input parameter is renamed — "cannot
-- change name of input parameter" — so a tidier name here is a migration that
-- fails on any database where 00004 has already run, which is every real one.
-- The rehearsal in scripts/check-migrations.sh caught exactly that, on the first
-- pass, before this reached anything.
create or replace function assam_floods.enrol_user(p_user_id uuid, p_email text)
returns table (id uuid, email text, role text)
language plpgsql
security definer
set search_path = assam_floods, public
as $$
#variable_conflict use_column
declare
  granted_role text;
begin
  select g.role into granted_role
  from assam_floods.role_grants g
  where lower(g.email) = lower(p_email)
  limit 1;

  insert into assam_floods.user_profiles (id, email, role, role_source, enrolled_via, auth_created_at)
  select p_user_id,
         p_email,
         coalesce(granted_role, 'citizen'),
         case when granted_role is null then 'self' else 'grant' end,
         'self-registration',
         u.created_at
  from auth.users u
  where u.id = p_user_id
  on conflict (id) do nothing;

  return query
    select p.id, p.email, p.role
    from assam_floods.user_profiles p
    where p.id = p_user_id;
end
$$;

revoke all on function assam_floods.enrol_user(uuid, text) from public, anon, authenticated;
grant execute on function assam_floods.enrol_user(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Reading and writing profiles
-- ---------------------------------------------------------------------------
-- `service_role` already holds what it needs from 00004; this is stated for the
-- same reason 00009 states its grants — so that the intent is legible and adding
-- a grant to `authenticated` would look like the deliberate change it would be.
-- The browser must never reach this table: a role is exactly the thing a user
-- must not be able to write about themselves.
revoke all on assam_floods.user_profiles from public, anon;

-- ---------------------------------------------------------------------------
-- What is deliberately NOT here
-- ---------------------------------------------------------------------------
-- NO `role_changes` TABLE. Every role change is written to `audit_log` (00006)
-- as `user.role-changed.v1`, through the same append-only path as every other
-- attributed change — `update` and `delete` are revoked from `service_role`
-- itself there, so a role change cannot be edited or erased even by the process
-- that wrote it. A second, parallel history table would be a second thing to
-- keep in step, and the weaker of the two would become the one somebody trusts.
--
-- NO in-app write to `role_grants`. That table is the root of trust and its only
-- author is a migration. If the API could write to it, "who may appoint
-- administrators" would stop being a question answerable from this repository,
-- which is the entire property this migration exists to preserve.
