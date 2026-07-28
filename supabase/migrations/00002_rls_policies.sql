-- AFRIP Row-Level Security (ADR 0004)
-- Default posture: RLS on everywhere; writes go through service-role backend only.
-- Public transparency dashboard reads pseudonymised views, never raw beneficiary rows.
--
-- Everything here lives in `assam_floods` (see 00001 for why the project's
-- `public` schema is off limits). That relocation has one consequence worth
-- spelling out: Supabase's default privileges only cover `public`, so a custom
-- schema starts with NO grants at all — not even for service_role. The grants
-- below therefore re-establish, explicitly, what `public` would have handed out
-- implicitly. RLS still does the row-level gating; grants only decide who may
-- reach the table to be gated.
--
-- Idempotent: policies are dropped before being recreated (Postgres has no
-- `create policy if not exists`) and views use `create or replace`.

-- ---------------------------------------------------------------------------
-- Schema-level access
-- ---------------------------------------------------------------------------
grant usage on schema assam_floods to anon, authenticated, service_role;

-- Enable RLS on every context table
alter table assam_floods.village_registry_villages enable row level security;
alter table assam_floods.village_registry_damage_assessments enable row level security;
alter table assam_floods.ngo_coordination_ngos enable row level security;
alter table assam_floods.ngo_coordination_assignments enable row level security;
alter table assam_floods.ngo_coordination_committee_members enable row level security;
alter table assam_floods.beneficiary_registry_beneficiaries enable row level security;
alter table assam_floods.beneficiary_registry_aid_records enable row level security;
alter table assam_floods.beneficiary_registry_follow_ups enable row level security;
alter table assam_floods.beneficiary_registry_duplicate_flags enable row level security;
alter table assam_floods.fund_monitoring_projects enable row level security;
alter table assam_floods.fund_monitoring_expenditures enable row level security;
alter table assam_floods.fund_monitoring_anomalies enable row level security;
alter table assam_floods.issue_tracking_issues enable row level security;
alter table assam_floods.volunteer_management_volunteers enable row level security;
alter table assam_floods.volunteer_management_assignments enable row level security;
alter table assam_floods.recovery_intelligence_indices enable row level security;
alter table assam_floods.recovery_intelligence_history enable row level security;
alter table assam_floods.smi_signals enable row level security;
alter table assam_floods.smi_alerts enable row level security;
alter table assam_floods.development_planning_plans enable row level security;
alter table assam_floods.development_planning_goals enable row level security;
alter table assam_floods.development_planning_milestones enable row level security;
alter table assam_floods.domain_events_outbox enable row level security;

-- ---------------------------------------------------------------------------
-- The backend writes as service_role, which bypasses RLS but still needs the
-- table-level privilege that `public` would have granted for free.
-- ---------------------------------------------------------------------------
grant all on all tables in schema assam_floods to service_role;
grant usage, select on all sequences in schema assam_floods to service_role;

-- Authenticated stakeholders (district / NGO / village roles refined later via JWT claims).
-- Grant reaches the table; the policy decides which rows come back.
grant select on
  assam_floods.village_registry_villages,
  assam_floods.village_registry_damage_assessments,
  assam_floods.ngo_coordination_ngos,
  assam_floods.ngo_coordination_assignments,
  assam_floods.fund_monitoring_projects,
  assam_floods.issue_tracking_issues,
  assam_floods.recovery_intelligence_indices,
  assam_floods.beneficiary_registry_beneficiaries
  to authenticated;

drop policy if exists "authenticated read villages" on assam_floods.village_registry_villages;
create policy "authenticated read villages" on assam_floods.village_registry_villages
  for select to authenticated using (true);

drop policy if exists "authenticated read damage" on assam_floods.village_registry_damage_assessments;
create policy "authenticated read damage" on assam_floods.village_registry_damage_assessments
  for select to authenticated using (true);

drop policy if exists "authenticated read ngos" on assam_floods.ngo_coordination_ngos;
create policy "authenticated read ngos" on assam_floods.ngo_coordination_ngos
  for select to authenticated using (true);

drop policy if exists "authenticated read assignments" on assam_floods.ngo_coordination_assignments;
create policy "authenticated read assignments" on assam_floods.ngo_coordination_assignments
  for select to authenticated using (true);

drop policy if exists "authenticated read projects" on assam_floods.fund_monitoring_projects;
create policy "authenticated read projects" on assam_floods.fund_monitoring_projects
  for select to authenticated using (true);

drop policy if exists "authenticated read issues" on assam_floods.issue_tracking_issues;
create policy "authenticated read issues" on assam_floods.issue_tracking_issues
  for select to authenticated using (true);

drop policy if exists "authenticated read indices" on assam_floods.recovery_intelligence_indices;
create policy "authenticated read indices" on assam_floods.recovery_intelligence_indices
  for select to authenticated using (true);

-- Beneficiary data: only NGO-scoped authenticated users; enforced strictly later via
-- JWT claim ngo_id matched against the village's active assignment.
drop policy if exists "ngo-scoped read beneficiaries" on assam_floods.beneficiary_registry_beneficiaries;
create policy "ngo-scoped read beneficiaries" on assam_floods.beneficiary_registry_beneficiaries
  for select to authenticated
  using (
    exists (
      select 1 from assam_floods.ngo_coordination_assignments a
      where a.village_id = assam_floods.beneficiary_registry_beneficiaries.village_id
        and a.status = 'active'
        and a.ngo_id = coalesce(auth.jwt() ->> 'ngo_id', '')
    )
  );

-- ---------------------------------------------------------------------------
-- Public transparency dashboard: pseudonymised / aggregate views only.
-- `public_` here is the audience, not the schema — both views live in
-- `assam_floods` like everything else. They are plain (non-security_invoker)
-- views, so anon reads them as the view owner and needs no grant on the
-- underlying tables: the view IS the privacy boundary.
-- ---------------------------------------------------------------------------
create or replace view assam_floods.public_village_recovery as
  select v.id, v.name, v.district, v.state, v.severity,
         r.composite as recovery_score, r.calculated_at
  from assam_floods.village_registry_villages v
  left join assam_floods.recovery_intelligence_indices r on r.village_id = v.id;

create or replace view assam_floods.public_fund_transparency as
  select p.id, p.village_id, p.name, p.category, p.fund_source, p.currency,
         p.sanctioned_minor, p.released_minor, p.spent_minor, p.status
  from assam_floods.fund_monitoring_projects p;

grant select on assam_floods.public_village_recovery, assam_floods.public_fund_transparency
  to anon;
