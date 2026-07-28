# ADR 0004 — Supabase (Postgres) as primary data store behind repository ports

**Status:** Accepted

## Context
The platform needs a primary store with relational integrity (fund arithmetic, assignment
uniqueness), row-level security for four role-scoped dashboards, storage for media evidence, and a
public read surface for the transparency dashboard. The team already operates a Supabase
organization. The concept document also permits publicly accessible Google Drive for public data
sources.

## Decision
- **Supabase Postgres is the primary system of record.** Each bounded context owns its tables
  (prefixed per context, e.g. `village_registry_villages`), accessed only through that context's
  repository adapter.
- Schema ships as SQL migrations in `supabase/migrations/`, applied via the Supabase MCP/CLI.
  Key invariants that are cheap in SQL are duplicated as constraints
  (e.g. `spent <= released`, one active assignment per village as a partial unique index) —
  defence in depth behind the domain model, not a replacement for it.
- **Row-Level Security** enforces dashboard scoping (district / NGO / village / public); the
  public role sees pseudonymised views only.
- **Provisioning note:** creating the Supabase project incurs a cost that requires explicit user
  confirmation; until confirmed, all tests run against in-memory fakes and the migrations are the
  deployable artifact.
- **Google Drive (public)** is admitted only as a *bulk source* for reference data ingestion
  (e.g. published government datasets) via an ingestion port — never as a system of record.

## Consequences
- Domain code never imports the Supabase SDK; swapping stores is an adapter concern.
- Migrations are reviewable in PRs and reproducible across environments.
- RLS gives the public transparency dashboard for free once policies are written.
