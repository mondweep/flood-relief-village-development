-- AFRIP Row-Level Security (ADR 0004)
-- Default posture: RLS on everywhere; writes go through service-role backend only.
-- Public transparency dashboard reads pseudonymised views, never raw beneficiary rows.

-- Enable RLS on every context table
alter table village_registry_villages enable row level security;
alter table village_registry_damage_assessments enable row level security;
alter table ngo_coordination_ngos enable row level security;
alter table ngo_coordination_assignments enable row level security;
alter table ngo_coordination_committee_members enable row level security;
alter table beneficiary_registry_beneficiaries enable row level security;
alter table beneficiary_registry_aid_records enable row level security;
alter table beneficiary_registry_follow_ups enable row level security;
alter table beneficiary_registry_duplicate_flags enable row level security;
alter table fund_monitoring_projects enable row level security;
alter table fund_monitoring_expenditures enable row level security;
alter table fund_monitoring_anomalies enable row level security;
alter table issue_tracking_issues enable row level security;
alter table volunteer_management_volunteers enable row level security;
alter table volunteer_management_assignments enable row level security;
alter table recovery_intelligence_indices enable row level security;
alter table recovery_intelligence_history enable row level security;
alter table smi_signals enable row level security;
alter table smi_alerts enable row level security;
alter table development_planning_plans enable row level security;
alter table development_planning_goals enable row level security;
alter table development_planning_milestones enable row level security;
alter table domain_events_outbox enable row level security;

-- Authenticated stakeholders (district / NGO / village roles refined later via JWT claims)
create policy "authenticated read villages" on village_registry_villages
  for select to authenticated using (true);
create policy "authenticated read damage" on village_registry_damage_assessments
  for select to authenticated using (true);
create policy "authenticated read ngos" on ngo_coordination_ngos
  for select to authenticated using (true);
create policy "authenticated read assignments" on ngo_coordination_assignments
  for select to authenticated using (true);
create policy "authenticated read projects" on fund_monitoring_projects
  for select to authenticated using (true);
create policy "authenticated read issues" on issue_tracking_issues
  for select to authenticated using (true);
create policy "authenticated read indices" on recovery_intelligence_indices
  for select to authenticated using (true);

-- Beneficiary data: only NGO-scoped authenticated users; enforced strictly later via
-- JWT claim ngo_id matched against the village's active assignment.
create policy "ngo-scoped read beneficiaries" on beneficiary_registry_beneficiaries
  for select to authenticated
  using (
    exists (
      select 1 from ngo_coordination_assignments a
      where a.village_id = beneficiary_registry_beneficiaries.village_id
        and a.status = 'active'
        and a.ngo_id = coalesce(auth.jwt() ->> 'ngo_id', '')
    )
  );

-- Public transparency dashboard: pseudonymised / aggregate views only
create view public_village_recovery as
  select v.id, v.name, v.district, v.state, v.severity,
         r.composite as recovery_score, r.calculated_at
  from village_registry_villages v
  left join recovery_intelligence_indices r on r.village_id = v.id;

create view public_fund_transparency as
  select p.id, p.village_id, p.name, p.category, p.fund_source, p.currency,
         p.sanctioned_minor, p.released_minor, p.spent_minor, p.status
  from fund_monitoring_projects p;

grant select on public_village_recovery, public_fund_transparency to anon;
