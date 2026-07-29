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
-- read it and hang a trigger off it, we never alter its tables.
--
-- Idempotent throughout: `if not exists`, `create or replace`, `on conflict`,
-- and policies/triggers dropped before being recreated (Postgres has no
-- `create policy if not exists`). Re-running this file is a no-op.
--
-- ===========================================================================
-- UNRESOLVED, AND IT NEEDS A PRODUCT DECISION BEFORE THIS REACHES THE SHARED
-- PROJECT. Not a hypothetical: measured against a real Postgres with these
-- four migrations applied.
--
-- This project is SHARED with unrelated applications (00001's header names
-- four). GoTrue's user pool is per-PROJECT, so `auth.users` is not AFRIP's
-- table — it is everyone's. The trigger below fires on ANY insert into it.
-- Consequence: a signup for a neighbouring application is auto-enrolled as an
-- AFRIP `citizen`, with no AFRIP involvement at all.
--
-- That would be tolerable if `citizen` were a floor. It is not, yet: ADR 0009
-- has not landed, no API route consults `role`, so `citizen` currently means
-- FULL access to every authenticated endpoint — beneficiaries included.
-- Verified: a user seeded only as a neighbouring app's account received a
-- profile row from this trigger without touching AFRIP.
--
-- This was written exactly as specified, and the specification is reasonable
-- for a project AFRIP owns alone. The conflict is with 00001's context, not
-- with the instruction. Three ways out, all of them decisions rather than
-- fixes, which is why none has been taken here:
--   1. Enforce roles (ADR 0009) so `citizen` is a floor rather than a skeleton
--      key. Fixes the blast radius, not the auto-enrolment.
--   2. Scope the trigger to signups that identify themselves as AFRIP's. Note
--      that signup metadata is user-controlled, so this bounds accidental
--      enrolment, not deliberate — acceptable if `citizen` is a floor, not if
--      it is full access.
--   3. Drop auto-enrolment: profiles only for `role_grants` entries, i.e. no
--      open self-registration. Safest, and contradicts ADR 0008's requirement
--      that people can register themselves.
--
-- (1) is required regardless. Until one of them ships, treat the API as
-- readable by any authenticated user of this Supabase project.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Role grants by email — the administrator bootstrap
-- ---------------------------------------------------------------------------
-- Keyed on EMAIL rather than on a user id, because the id does not exist until
-- the person signs up and we refuse to make "the administrator exists" depend on
-- the order in which a deploy and a signup happen. A grant sitting here is
-- applied on the spot if the account is already present, and by the signup
-- trigger if it is not. Either way the administrator is identical in every
-- environment and the grant is reviewable in version control rather than being
-- a click somebody made in a dashboard once.
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
-- User profiles — one row per auth.users row
-- ---------------------------------------------------------------------------
-- `id` mirrors `auth.users.id` and is NOT declared as a foreign key to it.
-- That is a judgement, not an oversight: `auth` is Supabase-managed, a FK into
-- it makes this schema undroppable independently and couples our migrations to
-- theirs. The `after insert` trigger below keeps the two in step, and a profile
-- whose auth user has been deleted is inert — no token will ever carry its
-- `sub` again.
create table if not exists assam_floods.user_profiles (
  id uuid primary key,
  email text not null unique,
  role text not null default 'citizen'
    check (role in ('admin','district_officer','ngo_coordinator','village_committee','citizen')),
  created_at timestamptz not null default now()
);

-- The signup trigger and the bootstrap both match on lower(email); without this
-- index each does a sequential scan, and the uniqueness above is case-sensitive
-- so it cannot serve the lookup.
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
drop policy if exists "read own profile" on assam_floods.user_profiles;
create policy "read own profile" on assam_floods.user_profiles
  for select to authenticated
  using (id = auth.uid());

-- ---------------------------------------------------------------------------
-- Keeping profiles in step with auth.users
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because the inserting role at signup time is GoTrue's, which
-- has no privileges in `assam_floods`. `search_path` is pinned so the function
-- cannot be redirected by a caller's search_path — the standard hardening for a
-- definer function.
--
-- The role is read from `role_grants` and defaults to 'citizen'. It is never
-- read from `new.raw_user_meta_data`: that is user-supplied, and a self-service
-- signup that could name its own role would make every other control here
-- decorative.
--
-- WHO this fires for is the open question — see the boxed note at the top of
-- this file. On a shared project `auth.users` carries every application's
-- signups, so this enrols all of them. Read that note before changing the role
-- logic here; the role it assigns is not the part that needs attention.
create or replace function assam_floods.sync_user_profile()
returns trigger
language plpgsql
security definer
set search_path = assam_floods, pg_catalog
as $$
declare
  granted_role text;
begin
  if new.email is null then
    return new;
  end if;

  select g.role into granted_role
  from assam_floods.role_grants g
  where lower(g.email) = lower(new.email);

  insert into assam_floods.user_profiles (id, email, role)
  values (new.id, new.email, coalesce(granted_role, 'citizen'))
  on conflict (id) do update
    set email = excluded.email,
        -- An existing role is preserved unless a grant says otherwise: a
        -- password reset or an email confirmation must not silently demote a
        -- district officer back to citizen.
        role = coalesce(granted_role, user_profiles.role);

  return new;
end;
$$;

revoke all on function assam_floods.sync_user_profile() from public;

-- `auth.users` is absent when this schema is applied to a plain Postgres (a
-- local test database, a CI fixture). The tables above are still worth having
-- there, so the trigger is skipped with a notice rather than failing the whole
-- migration.
do $$
begin
  if to_regclass('auth.users') is null then
    raise notice 'auth.users not present — skipping profile sync trigger and backfill';
  else
    execute 'drop trigger if exists sync_user_profile_on_signup on auth.users';
    execute $t$
      create trigger sync_user_profile_on_signup
        after insert on auth.users
        for each row execute function assam_floods.sync_user_profile()
    $t$;

    -- Backfill, scoped to granted emails ONLY — deliberately not every account.
    --
    -- `auth.users` is project-wide, and this Supabase project is shared with
    -- unrelated applications (see 00001). At the time of writing it held 22
    -- accounts belonging to those other apps and none belonging to AFRIP. A
    -- blanket backfill would have copied 22 strangers' email addresses into an
    -- AFRIP table, which is a data-boundary violation dressed up as convenience:
    -- those people never used this platform and their addresses are not ours to
    -- hold.
    --
    -- Restricting to `role_grants` means the only row created here is the
    -- administrator's, if they have already signed up. Everyone else gets a
    -- profile when they actually sign up, via the trigger above.
    execute $b$
      insert into assam_floods.user_profiles (id, email, role)
      select u.id, u.email, g.role
      from auth.users u
      join assam_floods.role_grants g on lower(g.email) = lower(u.email)
      where u.email is not null
      on conflict (id) do nothing
    $b$;
  end if;
end
$$;

-- Apply every grant to whatever profiles exist now. This is the half of the
-- bootstrap that runs when the administrator HAS already signed up, and it is
-- written as a plain idempotent update so re-running the migration re-asserts
-- the intended state instead of assuming nothing has drifted since.
update assam_floods.user_profiles p
set role = g.role
from assam_floods.role_grants g
where lower(p.email) = lower(g.email)
  and p.role is distinct from g.role;
