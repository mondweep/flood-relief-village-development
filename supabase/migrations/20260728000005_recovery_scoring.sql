-- BC-5 Recovery Scoring: append-only score history per village
create schema if not exists recovery_scoring;

create table recovery_scoring.score_entries (
  id uuid primary key,
  village_id uuid not null,
  composite smallint not null check (composite between 0 and 100),
  categories jsonb not null, -- {"infrastructure": 40, ... all 11 categories}
  calculated_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

create table recovery_scoring.domain_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz
);

create index on recovery_scoring.score_entries (village_id, calculated_at desc);

alter table recovery_scoring.score_entries enable row level security;
alter table recovery_scoring.domain_events enable row level security;

-- Recovery scores are public by design (transparency dashboard)
create view recovery_scoring.public_scores
  with (security_invoker = off) as
  select distinct on (village_id) village_id, composite, calculated_at
  from recovery_scoring.score_entries
  order by village_id, calculated_at desc;

create policy scores_insert on recovery_scoring.score_entries
  for insert with check (auth.jwt() ->> 'role' in ('district_admin','service'));
create policy scores_read on recovery_scoring.score_entries
  for select using (auth.role() = 'authenticated');
