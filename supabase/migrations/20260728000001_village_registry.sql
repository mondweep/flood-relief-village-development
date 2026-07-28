-- BC-1 Village Registry (ADR-003: one schema per bounded context; ADR-007: RLS default deny)
create schema if not exists village_registry;

create table village_registry.villages (
  id uuid primary key,
  name text not null check (length(trim(name)) > 0),
  district text not null check (length(trim(district)) > 0),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  population integer not null default 0 check (population >= 0),
  households integer not null default 0 check (households >= 0),
  affected_families integer not null default 0 check (affected_families >= 0),
  severity text not null default 'unaffected'
    check (severity in ('unaffected','low','moderate','severe','critical')),
  damaged_houses integer not null default 0 check (damaged_houses >= 0),
  damaged_schools integer not null default 0 check (damaged_schools >= 0),
  damaged_health_centres integer not null default 0 check (damaged_health_centres >= 0),
  damaged_water_sources integer not null default 0 check (damaged_water_sources >= 0),
  agriculture_hectares_damaged numeric not null default 0 check (agriculture_hectares_damaged >= 0),
  livestock_lost integer not null default 0 check (livestock_lost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (affected_families <= households)
);

-- Severity audit trail (NFR-1: append-only)
create table village_registry.severity_changes (
  id bigint generated always as identity primary key,
  village_id uuid not null references village_registry.villages(id),
  from_severity text not null,
  to_severity text not null,
  reason text not null check (length(trim(reason)) > 0),
  changed_by uuid,
  changed_at timestamptz not null default now()
);

-- Transactional outbox (ADR-006)
create table village_registry.domain_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz
);

create index on village_registry.villages (district, severity);

alter table village_registry.villages enable row level security;
alter table village_registry.severity_changes enable row level security;
alter table village_registry.domain_events enable row level security;

-- Public transparency: aggregate view only (ADR-007)
create view village_registry.public_village_summary
  with (security_invoker = off) as
  select district, severity, count(*) as villages,
         sum(affected_families) as affected_families
  from village_registry.villages
  group by district, severity;

create policy district_admin_all on village_registry.villages
  for all using (auth.jwt() ->> 'role' = 'district_admin');
create policy authenticated_read on village_registry.villages
  for select using (auth.role() = 'authenticated');
create policy severity_audit_read on village_registry.severity_changes
  for select using (auth.role() = 'authenticated');
create policy severity_audit_insert on village_registry.severity_changes
  for insert with check (auth.jwt() ->> 'role' in ('district_admin','ngo_member'));
