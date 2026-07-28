-- BC-2 NGO Coordination: One Village, One NGO (partial unique index enforces the core invariant)
create schema if not exists ngo_coordination;

create table ngo_coordination.ngos (
  id uuid primary key,
  name text not null check (length(trim(name)) > 0),
  verified boolean not null default false,
  capacity integer not null default 1 check (capacity > 0),
  contact text,
  created_at timestamptz not null default now()
);

create table ngo_coordination.village_assignments (
  id uuid primary key,
  village_id uuid not null,
  ngo_id uuid not null references ngo_coordination.ngos(id),
  status text not null default 'active' check (status in ('active','released')),
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text,
  check (status <> 'released' or release_reason is not null)
);

-- THE invariant: at most one ACTIVE lead NGO per village (FR-NC-2), enforced at the database
create unique index one_active_ngo_per_village
  on ngo_coordination.village_assignments (village_id)
  where status = 'active';

create table ngo_coordination.leadership_teams (
  id uuid primary key,
  village_id uuid not null unique,
  leader text not null,
  volunteer text,
  engineer text,
  teacher text,
  doctor text,
  government_rep text,
  womens_rep text,
  formed_at timestamptz not null default now()
);

create table ngo_coordination.domain_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz
);

create index on ngo_coordination.village_assignments (ngo_id) where status = 'active';

alter table ngo_coordination.ngos enable row level security;
alter table ngo_coordination.village_assignments enable row level security;
alter table ngo_coordination.leadership_teams enable row level security;
alter table ngo_coordination.domain_events enable row level security;

-- Public transparency: which NGO serves which village is public information
create view ngo_coordination.public_assignments
  with (security_invoker = off) as
  select va.village_id, n.name as ngo_name, va.assigned_at
  from ngo_coordination.village_assignments va
  join ngo_coordination.ngos n on n.id = va.ngo_id
  where va.status = 'active';

create policy district_admin_all_ngos on ngo_coordination.ngos
  for all using (auth.jwt() ->> 'role' = 'district_admin');
create policy authenticated_read_ngos on ngo_coordination.ngos
  for select using (auth.role() = 'authenticated');
create policy district_admin_all_assignments on ngo_coordination.village_assignments
  for all using (auth.jwt() ->> 'role' = 'district_admin');
create policy authenticated_read_assignments on ngo_coordination.village_assignments
  for select using (auth.role() = 'authenticated');
create policy authenticated_read_teams on ngo_coordination.leadership_teams
  for select using (auth.role() = 'authenticated');
