-- AFRIP initial schema (ADR 0004)
-- Each bounded context owns its tables (context prefix). SQL constraints duplicate
-- cheap domain invariants as defence-in-depth behind the domain model.

-- ---------------------------------------------------------------------------
-- Village Registry
-- ---------------------------------------------------------------------------
create table village_registry_villages (
  id text primary key,
  name text not null,
  district text not null,
  state text not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  population integer not null check (population >= 0),
  households integer not null check (households >= 0),
  affected_families integer not null check (affected_families >= 0),
  severity text not null check (severity in ('minor', 'moderate', 'severe', 'critical')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (affected_families <= households)
);

create table village_registry_damage_assessments (
  id bigint generated always as identity primary key,
  village_id text not null references village_registry_villages (id),
  assessed_at timestamptz not null,
  houses_damaged integer not null check (houses_damaged >= 0),
  schools_damaged integer not null check (schools_damaged >= 0),
  health_centres_damaged integer not null check (health_centres_damaged >= 0),
  water_sources_damaged integer not null check (water_sources_damaged >= 0),
  agriculture_hectares_lost numeric not null check (agriculture_hectares_lost >= 0),
  livestock_lost integer not null check (livestock_lost >= 0),
  notes text
);

-- ---------------------------------------------------------------------------
-- NGO Coordination (One Village, One NGO)
-- ---------------------------------------------------------------------------
create table ngo_coordination_ngos (
  id text primary key,
  name text not null,
  focus_areas text[] not null default '{}',
  capacity integer not null check (capacity >= 1),
  created_at timestamptz not null default now()
);

create table ngo_coordination_assignments (
  id text primary key,
  village_id text not null references village_registry_villages (id),
  ngo_id text not null references ngo_coordination_ngos (id),
  status text not null check (status in ('active', 'retired')),
  assigned_at timestamptz not null,
  retired_at timestamptz
);

-- The flagship invariant: at most one ACTIVE assignment per village.
create unique index one_active_assignment_per_village
  on ngo_coordination_assignments (village_id)
  where status = 'active';

create table ngo_coordination_committee_members (
  id bigint generated always as identity primary key,
  assignment_id text not null references ngo_coordination_assignments (id),
  role text not null check (role in ('leader', 'volunteer', 'engineer', 'teacher', 'doctor',
                                     'government_rep', 'health_worker', 'school_rep', 'womens_rep')),
  name text not null,
  contact text,
  unique (assignment_id, role)
);

-- ---------------------------------------------------------------------------
-- Beneficiary Registry
-- ---------------------------------------------------------------------------
create table beneficiary_registry_beneficiaries (
  id text primary key,
  village_id text not null references village_registry_villages (id),
  name text not null,
  category text not null check (category in ('widow', 'orphan', 'senior_citizen', 'disabled',
                                             'pregnant_woman', 'farmer', 'small_business',
                                             'daily_wage_worker', 'student')),
  created_at timestamptz not null default now()
);

create table beneficiary_registry_aid_records (
  id bigint generated always as identity primary key,
  beneficiary_id text not null references beneficiary_registry_beneficiaries (id),
  aid_type text not null check (aid_type in ('food', 'shelter', 'medical', 'cash', 'livelihood', 'education')),
  provider_id text not null,
  provider_type text not null check (provider_type in ('ngo', 'government', 'donor')),
  delivered_at timestamptz not null,
  notes text
);

create table beneficiary_registry_follow_ups (
  id text not null,
  beneficiary_id text not null references beneficiary_registry_beneficiaries (id),
  due_at timestamptz not null,
  completed_at timestamptz,
  primary key (beneficiary_id, id)
);

create table beneficiary_registry_duplicate_flags (
  id bigint generated always as identity primary key,
  beneficiary_id text not null references beneficiary_registry_beneficiaries (id),
  aid_type text not null,
  provider_ids text[] not null,
  flagged_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Fund Monitoring
-- ---------------------------------------------------------------------------
create table fund_monitoring_projects (
  id text primary key,
  village_id text not null references village_registry_villages (id),
  name text not null,
  category text not null check (category in ('bridge', 'school', 'water_supply', 'housing', 'road', 'health', 'other')),
  fund_source text not null check (fund_source in ('district', 'csr', 'ngo', 'donor', 'mla', 'mp', 'scheme')),
  currency text not null default 'INR',
  sanctioned_minor bigint not null check (sanctioned_minor >= 0),
  released_minor bigint not null default 0 check (released_minor >= 0),
  spent_minor bigint not null default 0 check (spent_minor >= 0),
  status text not null check (status in ('sanctioned', 'in_progress', 'completed', 'verified')),
  created_at timestamptz not null default now(),
  check (released_minor <= sanctioned_minor),
  check (spent_minor <= released_minor)
);

create table fund_monitoring_expenditures (
  id bigint generated always as identity primary key,
  project_id text not null references fund_monitoring_projects (id),
  amount_minor bigint not null check (amount_minor > 0),
  description text not null,
  evidence_ref text,
  spent_at timestamptz not null
);

create table fund_monitoring_anomalies (
  id bigint generated always as identity primary key,
  project_id text not null references fund_monitoring_projects (id),
  type text not null check (type in ('overspend_vs_comparable', 'stalled', 'duplicate_funding')),
  detected_at timestamptz not null,
  details text not null
);

-- ---------------------------------------------------------------------------
-- Issue Tracking
-- ---------------------------------------------------------------------------
create table issue_tracking_issues (
  id text primary key,
  village_id text not null references village_registry_villages (id),
  category text not null check (category in ('infrastructure', 'water', 'education', 'health', 'food', 'corruption', 'other')),
  description text not null,
  photo_refs text[] not null default '{}',
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  status text not null check (status in ('open', 'routed', 'in_progress', 'resolved', 'verified')),
  routed_party_type text check (routed_party_type in ('lead_ngo', 'government_department')),
  routed_party text,
  reported_at timestamptz not null,
  resolved_at timestamptz,
  resolution_note text
);

-- ---------------------------------------------------------------------------
-- Volunteer Management
-- ---------------------------------------------------------------------------
create table volunteer_management_volunteers (
  id text primary key,
  name text not null,
  skills text[] not null default '{}',
  languages text[] not null default '{}',
  location text not null,
  availability text not null check (availability in ('available', 'unavailable')),
  created_at timestamptz not null default now()
);

create table volunteer_management_assignments (
  id text not null,
  volunteer_id text not null references volunteer_management_volunteers (id),
  village_id text not null references village_registry_villages (id),
  task text not null,
  assigned_at timestamptz not null,
  hours numeric not null default 0 check (hours >= 0),
  primary key (volunteer_id, id)
);

-- ---------------------------------------------------------------------------
-- Recovery Intelligence
-- ---------------------------------------------------------------------------
create table recovery_intelligence_indices (
  village_id text primary key references village_registry_villages (id),
  scores jsonb not null,
  composite integer not null check (composite between 0 and 100),
  calculated_at timestamptz not null
);

create table recovery_intelligence_history (
  id bigint generated always as identity primary key,
  village_id text not null references village_registry_villages (id),
  composite integer not null check (composite between 0 and 100),
  calculated_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Social Media Intelligence
-- ---------------------------------------------------------------------------
create table smi_signals (
  id text primary key,
  source text not null check (source in ('facebook', 'x', 'instagram', 'youtube', 'news', 'whatsapp_field_report', 'other')),
  raw_text text not null,
  extracted jsonb not null,
  detected_at timestamptz not null
);

create table smi_alerts (
  id text primary key,
  type text not null check (type in ('new_relief_activity', 'duplicate_aid_likely', 'no_ngo_assigned',
                                     'possible_orphan_identified', 'medical_support_needed')),
  signal_id text not null references smi_signals (id),
  village_name text,
  details text not null,
  raised_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Development Planning
-- ---------------------------------------------------------------------------
create table development_planning_plans (
  id text primary key,
  village_id text not null unique references village_registry_villages (id),
  created_at timestamptz not null default now()
);

create table development_planning_goals (
  id text not null,
  plan_id text not null references development_planning_plans (id),
  area text not null check (area in ('education', 'livelihood', 'health', 'infrastructure',
                                     'women_empowerment', 'digital_literacy')),
  description text not null,
  primary key (plan_id, id)
);

create table development_planning_milestones (
  id text not null,
  plan_id text not null,
  goal_id text not null,
  title text not null,
  target_date date not null,
  completed_at timestamptz,
  primary key (plan_id, goal_id, id),
  foreign key (plan_id, goal_id) references development_planning_goals (plan_id, id)
);

-- ---------------------------------------------------------------------------
-- Domain event outbox (ADR 0005 durable-delivery path)
-- ---------------------------------------------------------------------------
create table domain_events_outbox (
  id bigint generated always as identity primary key,
  name text not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  published_at timestamptz
);

create index domain_events_outbox_unpublished on domain_events_outbox (id) where published_at is null;
