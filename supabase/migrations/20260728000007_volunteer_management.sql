-- BC-7 Volunteer Management
create schema if not exists volunteer_management;

create table volunteer_management.volunteers (
  id uuid primary key,
  name text not null check (length(trim(name)) > 0),
  contact text not null check (length(trim(contact)) > 0),
  skills text[] not null check (array_length(skills, 1) >= 1),
  languages text[] not null check (array_length(languages, 1) >= 1),
  location text not null,
  availability text not null check (availability in ('weekdays','weekends','full_time')),
  active_village_id uuid,
  active_role text,
  active_since timestamptz,
  total_hours numeric not null default 0 check (total_hours >= 0),
  certificates text[] not null default '{}',
  created_at timestamptz not null default now(),
  -- single active assignment: all three set or all three null
  check (
    (active_village_id is null and active_role is null and active_since is null) or
    (active_village_id is not null and active_role is not null and active_since is not null)
  )
);

create table volunteer_management.service_logs (
  id uuid primary key,
  volunteer_id uuid not null references volunteer_management.volunteers(id),
  village_id uuid not null,
  hours numeric not null check (hours > 0),
  logged_at timestamptz not null default now()
);

create table volunteer_management.domain_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz
);

create index on volunteer_management.volunteers (active_village_id)
  where active_village_id is not null;

alter table volunteer_management.volunteers enable row level security;
alter table volunteer_management.service_logs enable row level security;
alter table volunteer_management.domain_events enable row level security;

-- Leaderboard is public (gamification), PII limited to name + hours
create view volunteer_management.public_leaderboard
  with (security_invoker = off) as
  select name, total_hours, certificates
  from volunteer_management.volunteers
  order by total_hours desc
  limit 100;

create policy volunteers_self_or_admin on volunteer_management.volunteers
  for all using (
    auth.jwt() ->> 'role' = 'district_admin' or id = auth.uid()
  );
create policy service_logs_read on volunteer_management.service_logs
  for select using (auth.role() = 'authenticated');
