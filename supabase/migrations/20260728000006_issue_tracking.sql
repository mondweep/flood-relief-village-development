-- BC-6 Issue Tracking: citizen grievances with photos + GPS, routed per policy
create schema if not exists issue_tracking;

create table issue_tracking.issues (
  id uuid primary key,
  village_id uuid not null,
  category text not null check (category in
    ('infrastructure','water','education','health','food','corruption','other')),
  description text not null check (length(trim(description)) > 0),
  reporter_contact text not null,
  status text not null default 'reported'
    check (status in ('reported','routed','in_progress','resolved','rejected')),
  routed_to_kind text check (routed_to_kind in ('ngo','district_department')),
  routed_to_ngo_id uuid,
  routed_to_department text,
  rejection_reason text,
  reported_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (status <> 'rejected' or rejection_reason is not null)
);

create table issue_tracking.attachments (
  id uuid primary key,
  issue_id uuid not null references issue_tracking.issues(id),
  photo_url text not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  uploaded_at timestamptz not null default now()
);

create table issue_tracking.domain_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz
);

create index on issue_tracking.issues (village_id, status);
create index on issue_tracking.issues (category) where status <> 'resolved';

alter table issue_tracking.issues enable row level security;
alter table issue_tracking.attachments enable row level security;
alter table issue_tracking.domain_events enable row level security;

-- Anyone authenticated may report; corruption issues visible to district admin only (ADR-007)
create policy issues_insert on issue_tracking.issues
  for insert with check (auth.role() = 'authenticated');
create policy issues_read_non_corruption on issue_tracking.issues
  for select using (category <> 'corruption' and auth.role() = 'authenticated');
create policy issues_read_corruption_admin on issue_tracking.issues
  for select using (category = 'corruption' and auth.jwt() ->> 'role' = 'district_admin');
create policy issues_update_admin on issue_tracking.issues
  for update using (auth.jwt() ->> 'role' in ('district_admin','ngo_member'));

-- Public sees aggregate issue counts per village
create view issue_tracking.public_issue_summary
  with (security_invoker = off) as
  select village_id, category, status, count(*) as issues
  from issue_tracking.issues
  where category <> 'corruption'
  group by village_id, category, status;
