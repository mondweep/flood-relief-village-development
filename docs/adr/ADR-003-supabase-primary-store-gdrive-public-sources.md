# ADR-003: Supabase as primary data store; public Google Drive for public data sources

**Status:** Accepted · **Date:** 2026-07-28

## Context

AFRIP needs a primary transactional store (villages, assignments, beneficiaries, funds,
issues, volunteers), role-based access for district/NGO/village/public personas, and an easy
path to auth, storage (photos, geo-tagged evidence) and realtime dashboards. The
stakeholders also want relevant **public** data sources (published scheme lists, NGO
reports, satellite exports) accessible without accounts.

## Decision

1. **Supabase (Postgres) is the primary data store.**
   - One Postgres **schema per bounded context** (`village_registry`, `ngo_coordination`,
     `beneficiary_registry`, `fund_monitoring`, `recovery_scoring`, `issue_tracking`,
     `volunteer_management`) to keep DDD context boundaries visible in the database.
   - **Row Level Security** implements persona access (NFR-2): NGOs see their assignments,
     the public transparency views expose aggregates only — never beneficiary PII or
     child-identifying data.
   - A per-context `domain_events` outbox table implements the transactional outbox for
     cross-context events; Supabase Edge Functions fan out.
   - Supabase Storage holds photos/evidence; Supabase Auth provides logins.
2. **Public Google Drive folders serve public documents** (government scheme PDFs, NGO
   reports, satellite image exports) behind a `PublicDocumentSource` port with a Google
   Drive adapter. Drive is a *document source*, never a system of record.
3. Repositories are the only code that touches tables; migrations live in
   `supabase/migrations/` and are applied via the Supabase CLI/MCP.

## Consequences

- Unit tests never touch Supabase (ports mocked — ADR-004); integration tests can run
  against any Supabase project or local `supabase start`.
- Creating the production Supabase project is a billing decision made by the product owner;
  the repo carries everything needed to `supabase db push` when the project exists.
- Swapping Drive for another public source is an adapter change only.
