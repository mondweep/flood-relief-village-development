-- AFRIP user identity (ADR 0008)
--
-- Supabase Auth (GoTrue) owns credentials, sessions and password recovery in
-- `auth.users`. It does NOT own application roles, and it must not: a user
-- controls their own signup payload, so anything they can put in
-- `raw_user_meta_data` is something they chose for themselves. This migration
-- adds the table that says what a verified identity is allowed to BE, alongside
-- the data it governs.
--
-- Everything below lives in `assam_floods`. See 00001 for why the project's
-- `public` schema is off limits: the Supabase project is shared with unrelated
-- applications and `public` is not ours. `auth` is Supabase's own schema — we
-- read one column of it, from a function, and that is all. We do not alter its
-- tables and, as of this version, we do not hang anything off them either.
--
-- Idempotent throughout: `if not exists`, `create or replace`, `on conflict`,
-- and policies dropped before being recreated (Postgres has no `create policy
-- if not exists`). Re-running this file is a no-op.
--
-- ===========================================================================
-- DECISION: NO AUTO-ENROLMENT. A profile is created only by a deliberate act.
--
-- An earlier version of this file carried an `after insert` trigger on
-- `auth.users` which created a `user_profiles` row for every signup on the
-- project. That was wrong here, and the reason is 00001's first paragraph:
-- GoTrue's user pool is per-PROJECT, and this project is shared with four
-- unrelated applications. `auth.users` is not AFRIP's table, it is everyone's.
-- At the time of writing it held 22 accounts, all belonging to those other
-- applications and none to AFRIP. The trigger therefore enrolled 22 strangers
-- as AFRIP citizens as a side effect of their signing up to a neighbouring app.
--
-- The trigger has been REMOVED, not scoped. Rows now appear in `user_profiles`
-- by exactly two paths:
--
--   1. `assam_floods.enrol_user(...)` below, called by the API when someone
--      completes AFRIP's own registration. This is the ordinary path, and it
--      is an explicit act by a person who came to AFRIP on purpose.
--   2. The `role_grants` backfill at the end of this file, which exists so the
--      administrator is present in every environment regardless of the order in
--      which a deploy and their signup happen.
--
-- Self-registration stays OPEN — ADR 0008 requires that anyone can register —
-- it simply stops being a side effect of signing up somewhere else.
--
-- WHAT THIS DOES NOT ACHIEVE, stated plainly so nobody mistakes it for a
-- boundary it is not: the other applications' users share our issuer, our
-- audience and our signing key, because they share the Supabase project. Any
-- one of those 22 accounts can still mint a token that AFRIP's verifier
-- accepts, and can therefore still visit AFRIP and register. What is removed
-- here is PASSIVE enrolment — being made an AFRIP user without ever having
-- heard of AFRIP. The shared credential pool is untouched and cannot be closed
-- from inside this schema. The only complete fix is a Supabase project
-- dedicated to AFRIP; the owner considered that and declined it. Treat any
-- authenticated identity as potentially belonging to a neighbouring
-- application, and see ADR 0009 for what a `citizen` is actually permitted to
-- do once inside — that, not this file, is what bounds the damage.
--
-- The provenance columns below (`enrolled_at`, `enrolled_via`,
-- `auth_created_at`) exist because of that residual gap: they let an
-- administrator review who let themselves in.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Role grants by email — the administrator bootstrap
-- ---------------------------------------------------------------------------
-- Keyed on EMAIL rather than on a user id, because the id does not exist until
-- the person signs up and we refuse to make "the administrator exists" depend on
-- the order in which a deploy and a signup happen. A grant sitting here is
-- applied on the spot if the account is already present, and by `enrol_user` if
-- the account registers later. Either way the administrator is identical in
-- every environment and the grant is reviewable in version control rather than
-- being a click somebody made in a dashboard once.
create table if not exists assam_floods.role_grants (
  email text primary key,
  role text not null
    check (role in ('admin','district_officer','ngo_coordinator','village_committee','citizen')),
  note text,
  granted_at timestamptz not null default now()
);

alter table assam_floods.role_grants enable row level security;
-- No policy, deliberately: nothing but service_role (which bypasses RLS) may
-- read or write this table. It is the file that decides who is an administrator.
grant all on assam_floods.role_grants to service_role;

insert into assam_floods.role_grants (email, role, note)
values ('mondweep@dxsure.uk', 'admin', 'Platform administrator bootstrap (ADR 0008)')
on conflict (email) do update
  set role = excluded.role,
      note = excluded.note;

-- ---------------------------------------------------------------------------
-- User profiles — one row per AFRIP user
-- ---------------------------------------------------------------------------
-- Note the wording: one row per AFRIP user, NOT one row per `auth.users` row.
-- Those were the same statement when a trigger mirrored the two tables; they
-- are deliberately different now. `user_profiles` is the smaller set, and the
-- difference between it and `auth.users` is the whole point of the decision
-- recorded above.
--
-- `id` mirrors `auth.users.id` and is NOT declared as a foreign key to it.
-- That is a judgement, not an oversight: `auth` is Supabase-managed, a FK into
-- it makes this schema undroppable independently and couples our migrations to
-- theirs. A profile whose auth user has been deleted is inert — no token will
-- ever carry its `sub` again.
--
-- PROVENANCE. `enrolled_at`/`enrolled_via`/`auth_created_at` record how each
-- row got here, because on a shared project "who let themselves in?" is a
-- question an administrator will eventually need to answer with data rather
-- than with a guess.
--
-- `auth_created_at` is the load-bearing one. It is the age of the underlying
-- GoTrue account at the moment of enrolment: an account created eight months
-- before it enrolled in AFRIP is almost certainly a neighbouring application's
-- user who wandered in, whereas one created seconds before is an ordinary new
-- signup. It is EVIDENCE, not a gate. Nothing in this file or in the API
-- refuses an enrolment on the strength of it, and nothing should: any threshold
-- you could pick would also catch a legitimate user who signed up yesterday and
-- came back to register today. Make the difference visible; let a human judge.
create table if not exists assam_floods.user_profiles (
  id uuid primary key,
  email text not null unique,
  role text not null default 'citizen'
    check (role in ('admin','district_officer','ngo_coordinator','village_committee','citizen')),
  created_at timestamptz not null default now(),
  enrolled_at timestamptz not null default now(),
  enrolled_via text
    constraint user_profiles_enrolled_via_check
    check (enrolled_via in ('self-registration','role-grant-bootstrap')),
  auth_created_at timestamptz
);

-- The upgrade path, for a database that already ran the previous version of
-- this file (a local or CI database — the version with the trigger was never
-- applied to the shared project). `create table if not exists` above is a no-op
-- there, so the new columns have to be added explicitly. Both paths converge on
-- the same shape and the same constraint name.
alter table assam_floods.user_profiles
  add column if not exists enrolled_at timestamptz not null default now();
alter table assam_floods.user_profiles
  add column if not exists enrolled_via text;
alter table assam_floods.user_profiles
  add column if not exists auth_created_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_profiles_enrolled_via_check'
  ) then
    alter table assam_floods.user_profiles
      add constraint user_profiles_enrolled_via_check
      check (enrolled_via in ('self-registration','role-grant-bootstrap'));
  end if;
end
$$;

-- `enrol_user` and the bootstrap both match on lower(email); without this index
-- each does a sequential scan, and the uniqueness above is case-sensitive so it
-- cannot serve the lookup.
create index if not exists user_profiles_email_lower on assam_floods.user_profiles (lower(email));
create index if not exists role_grants_email_lower on assam_floods.role_grants (lower(email));

alter table assam_floods.user_profiles enable row level security;

grant all on assam_floods.user_profiles to service_role;
-- Reaches the table; the policy below decides which rows come back. (Recall
-- from 00002 that a custom schema starts with no grants at all, so this has to
-- be spelled out where `public` would have implied it.)
grant select on assam_floods.user_profiles to authenticated;

-- A user may read their own profile and nothing else. Note what is absent:
-- there is no insert, update or delete policy and no write grant, so a signed-in
-- user cannot edit their own row — least of all its `role`. Promotion happens
-- through `role_grants` and the service-role backend, never from the client.
-- Note also that this policy is not the reason a neighbouring application's
-- user cannot enrol themselves as an admin: `enrol_user` below bypasses RLS
-- (SECURITY DEFINER) and is where that guarantee actually lives.
drop policy if exists "read own profile" on assam_floods.user_profiles;
create policy "read own profile" on assam_floods.user_profiles
  for select to authenticated
  using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Enrolment — the one path that creates a profile from a live request
-- ---------------------------------------------------------------------------
-- Called by the API (service_role) when a verified identity completes AFRIP's
-- registration. Deliberately a function rather than an insert from the adapter,
-- for two reasons:
--
--   * The API cannot read the `auth` schema through PostgREST — it is not in
--     the exposed schema list, and should not be. `auth_created_at` therefore
--     has to be filled in on this side of the wire.
--   * The role decision (`role_grants` → else 'citizen') stays in one place,
--     in SQL, next to the table it writes. An adapter that passed a role in
--     would be an adapter that could be made to pass the wrong one.
--
-- SECURITY DEFINER because it writes a table the caller may not write, and
-- reads a schema the caller cannot see. `search_path` is pinned so the function
-- cannot be redirected by a caller's search_path — the standard hardening for a
-- definer function. Execute is revoked from `public` and granted to
-- `service_role` alone: `anon` and `authenticated` must not be able to reach
-- this, or a browser holding the publishable key could enrol arbitrary uuids.
--
-- The role is read from `role_grants` and defaults to 'citizen'. It is NEVER
-- read from signup metadata, and there is no parameter through which a caller
-- could supply one. That restraint is the reason every other control here is
-- worth anything: `raw_user_meta_data` is written by the user during their own
-- signup, so a registration that could name its own role would make the whole
-- of this file decorative.
--
-- IDEMPOTENT, and specifically: a second call NEVER changes an existing row.
-- `on conflict (id) do nothing` followed by a read-back means re-registering
-- returns the profile that already exists — a district officer who clicks
-- register again is not demoted to citizen, and a retried request is not a
-- privilege change. The previous version of this file used `do update` for the
-- same insert; that was safe under a signup trigger and would not be safe here,
-- where the caller is a live request.
create or replace function assam_floods.enrol_user(p_user_id uuid, p_email text)
returns table (id uuid, email text, role text)
language plpgsql
security definer
set search_path = assam_floods, pg_catalog
as $$
-- REQUIRED, not stylistic. `returns table (id, email, role)` declares three OUT
-- parameters whose names are also columns of `user_profiles`, and plpgsql
-- resolves an unqualified name to the variable by default. Without this the
-- `on conflict (id)` below fails at RUNTIME — not at create time — with
-- `column reference "id" is ambiguous`, i.e. on the first real registration
-- rather than during the migration. `use_column` makes bare column names mean
-- columns; the local variables here are all prefixed and cannot collide.
#variable_conflict use_column
declare
  granted_role text;
  auth_created timestamptz;
begin
  -- `user_profiles.email` is `not null unique`. An empty or absent email would
  -- let the first such enrolment take the row and every later one collide on
  -- it, so refuse loudly here as well as in the adapter. Two guards on purpose:
  -- this one is the one that cannot be bypassed by a different caller.
  if p_user_id is null then
    raise exception 'enrol_user requires a user id';
  end if;
  if p_email is null or btrim(p_email) = '' then
    raise exception 'enrol_user requires an email (user %)', p_user_id;
  end if;

  select g.role into granted_role
  from assam_floods.role_grants g
  where lower(g.email) = lower(p_email);

  -- `auth.users` is absent when this schema is applied to a plain Postgres (a
  -- local test database, a CI fixture). Guarded and read dynamically for the
  -- same reason the previous version guarded its trigger: the function must be
  -- creatable and callable there, just with no provenance to record.
  if to_regclass('auth.users') is not null then
    execute 'select u.created_at from auth.users u where u.id = $1'
      into auth_created
      using p_user_id;
  end if;

  insert into assam_floods.user_profiles (id, email, role, enrolled_via, auth_created_at)
  values (
    p_user_id,
    p_email,
    coalesce(granted_role, 'citizen'),
    'self-registration',
    auth_created
  )
  on conflict (id) do nothing;

  -- Read back rather than `returning`, because `do nothing` returns no row on a
  -- repeat call and the caller still needs to be told who they are. This is
  -- what makes the second call idempotent instead of empty.
  return query
    select p.id, p.email, p.role
    from assam_floods.user_profiles p
    where p.id = p_user_id;
end;
$$;

revoke all on function assam_floods.enrol_user(uuid, text) from public;
grant execute on function assam_floods.enrol_user(uuid, text) to service_role;

-- Belt and braces: an earlier database may still carry the removed trigger and
-- its function. Neither should survive a re-run of this file.
do $$
begin
  if to_regclass('auth.users') is null then
    raise notice 'auth.users not present — skipping trigger cleanup and role-grant backfill';
  else
    execute 'drop trigger if exists sync_user_profile_on_signup on auth.users';

    -- Backfill, scoped to granted emails ONLY — deliberately not every account.
    --
    -- This is now the ONLY way a profile comes into existence without somebody
    -- deliberately registering, and it is here for one reason: so the
    -- administrator exists in every environment no matter whether they signed
    -- up before or after this migration ran. `role_grants` is version
    -- controlled, so the set of people this can enrol is the set of people a
    -- reviewer has already agreed to.
    --
    -- A blanket backfill would have copied 22 strangers' email addresses out of
    -- the shared `auth.users` into an AFRIP table — a data-boundary violation
    -- dressed up as convenience. Those people never used this platform and
    -- their addresses are not ours to hold. Everyone else gets a profile when
    -- they actually register, through `enrol_user`.
    execute $b$
      insert into assam_floods.user_profiles
        (id, email, role, enrolled_via, auth_created_at)
      select u.id, u.email, g.role, 'role-grant-bootstrap', u.created_at
      from auth.users u
      join assam_floods.role_grants g on lower(g.email) = lower(u.email)
      where u.email is not null
      on conflict (id) do nothing
    $b$;
  end if;
end
$$;

drop function if exists assam_floods.sync_user_profile();

-- Apply every grant to whatever profiles exist now. This is the half of the
-- bootstrap that runs when the administrator HAS already signed up (and already
-- has a profile), and it is written as a plain idempotent update so re-running
-- the migration re-asserts the intended state instead of assuming nothing has
-- drifted since.
update assam_floods.user_profiles p
set role = g.role
from assam_floods.role_grants g
where lower(p.email) = lower(g.email)
  and p.role is distinct from g.role;
