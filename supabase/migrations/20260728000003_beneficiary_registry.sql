-- BC-3 Beneficiary Registry: vulnerable people never disappear from records (ADR-007: strictest RLS)
create schema if not exists beneficiary_registry;

create table beneficiary_registry.beneficiaries (
  id uuid primary key,
  village_id uuid not null,
  full_name text not null check (length(trim(full_name)) > 0),
  categories text[] not null check (
    array_length(categories, 1) >= 1 and
    categories <@ array['widow','orphaned_child','senior_citizen','disabled','pregnant_woman',
                        'farmer','small_business','daily_wage_worker','student']
  ),
  needs text[] not null default '{}',
  photo_url text,
  next_follow_up_at timestamptz,
  created_at timestamptz not null default now(),
  -- widows and orphans must always have a scheduled follow-up (FR-BR-4)
  check (
    not (categories && array['widow','orphaned_child'])
    or next_follow_up_at is not null
  )
);

-- Aid history: append-only audit (NFR-1). No update/delete policies are created — inserts only.
create table beneficiary_registry.aid_events (
  id uuid primary key,
  beneficiary_id uuid not null references beneficiary_registry.beneficiaries(id),
  kind text not null,
  provider_name text not null,
  note text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

create table beneficiary_registry.follow_ups (
  id uuid primary key,
  beneficiary_id uuid not null references beneficiary_registry.beneficiaries(id),
  completed_at timestamptz not null,
  notes text,
  completed_by uuid
);

create table beneficiary_registry.domain_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  published_at timestamptz
);

create index on beneficiary_registry.aid_events (beneficiary_id, kind, occurred_at);
create index on beneficiary_registry.beneficiaries (village_id);
create index on beneficiary_registry.beneficiaries (next_follow_up_at)
  where next_follow_up_at is not null;

alter table beneficiary_registry.beneficiaries enable row level security;
alter table beneficiary_registry.aid_events enable row level security;
alter table beneficiary_registry.follow_ups enable row level security;
alter table beneficiary_registry.domain_events enable row level security;

-- Public sees aggregate counts ONLY — never identified vulnerable people (ADR-007)
create view beneficiary_registry.public_vulnerability_summary
  with (security_invoker = off) as
  select village_id, unnest(categories) as category, count(*) as beneficiaries
  from beneficiary_registry.beneficiaries
  group by village_id, category;

-- Identified records: district admins and (via app-scoped claims) the assigned NGO only
create policy district_admin_all on beneficiary_registry.beneficiaries
  for all using (auth.jwt() ->> 'role' = 'district_admin');
create policy ngo_read_scoped on beneficiary_registry.beneficiaries
  for select using (
    auth.jwt() ->> 'role' = 'ngo_member'
    and village_id::text = any (string_to_array(coalesce(auth.jwt() ->> 'village_ids', ''), ','))
  );
create policy aid_insert_field_roles on beneficiary_registry.aid_events
  for insert with check (auth.jwt() ->> 'role' in ('district_admin','ngo_member'));
create policy aid_read_scoped on beneficiary_registry.aid_events
  for select using (auth.jwt() ->> 'role' in ('district_admin','ngo_member'));
