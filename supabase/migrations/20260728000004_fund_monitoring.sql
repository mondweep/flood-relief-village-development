-- BC-4 Fund Monitoring: ledger ordering + append-only evidence (NFR-1)
create schema if not exists fund_monitoring;

create table fund_monitoring.funded_projects (
  id uuid primary key,
  village_id uuid not null,
  title text not null check (length(trim(title)) > 0),
  category text not null check (category in ('road','school','housing','water','health','bridge','other')),
  funding_source text not null check (funding_source in ('district','csr','ngo','donor','mla','mp','scheme')),
  currency char(3) not null default 'INR',
  sanctioned_minor bigint not null check (sanctioned_minor >= 0),
  released_minor bigint not null default 0 check (released_minor >= 0),
  spent_minor bigint not null default 0 check (spent_minor >= 0),
  status text not null default 'active' check (status in ('active','completed')),
  started_at timestamptz not null default now(),
  expected_completion_at timestamptz not null,
  completed_at timestamptz,
  -- FR-FM-2 ledger ordering, enforced at the database as the last line of defense
  check (released_minor <= sanctioned_minor),
  check (spent_minor <= released_minor)
);

create table fund_monitoring.ledger_entries (
  id uuid primary key,
  project_id uuid not null references fund_monitoring.funded_projects(id),
  entry_type text not null check (entry_type in ('release','expenditure')),
  amount_minor bigint not null check (amount_minor > 0),
  description text,
  occurred_at timestamptz not null default now(),
  check (entry_type <> 'expenditure' or description is not null)
);

create table fund_monitoring.evidence_items (
  id uuid primary key,
  project_id uuid not null references fund_monitoring.funded_projects(id),
  kind text not null check (kind in ('photo','invoice','completion_certificate','village_verification')),
  url text not null,
  lat double precision,
  lng double precision,
  attached_at timestamptz not null default now()
);

create table fund_monitoring.anomalies (
  id uuid primary key,
  project_id uuid not null references fund_monitoring.funded_projects(id),
  kind text not null check (kind in ('delayed','duplicate_funding','overspend')),
  details jsonb not null default '{}',
  flagged_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create table fund_monitoring.domain_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz
);

create index on fund_monitoring.funded_projects (village_id, category);
create index on fund_monitoring.ledger_entries (project_id, occurred_at);

alter table fund_monitoring.funded_projects enable row level security;
alter table fund_monitoring.ledger_entries enable row level security;
alter table fund_monitoring.evidence_items enable row level security;
alter table fund_monitoring.anomalies enable row level security;
alter table fund_monitoring.domain_events enable row level security;

-- Fund transparency is the point: public sees per-village totals
create view fund_monitoring.public_fund_summary
  with (security_invoker = off) as
  select village_id, category, funding_source, currency,
         sum(sanctioned_minor) as sanctioned_minor,
         sum(released_minor) as released_minor,
         sum(spent_minor) as spent_minor,
         count(*) filter (where status = 'completed') as completed_projects,
         count(*) as total_projects
  from fund_monitoring.funded_projects
  group by village_id, category, funding_source, currency;

create policy district_admin_all on fund_monitoring.funded_projects
  for all using (auth.jwt() ->> 'role' = 'district_admin');
create policy authenticated_read on fund_monitoring.funded_projects
  for select using (auth.role() = 'authenticated');
create policy ledger_read on fund_monitoring.ledger_entries
  for select using (auth.role() = 'authenticated');
create policy evidence_read on fund_monitoring.evidence_items
  for select using (auth.role() = 'authenticated');
create policy anomalies_admin on fund_monitoring.anomalies
  for all using (auth.jwt() ->> 'role' = 'district_admin');
