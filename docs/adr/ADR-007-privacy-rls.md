# ADR-007: Privacy by design — RLS personas and PII minimization

**Status:** Accepted · **Date:** 2026-07-28

## Context

The Beneficiary Registry holds data on widows, orphaned children and other vulnerable
people. The concept document also demands a *public transparency dashboard*. These pull in
opposite directions: accountability requires publishing; protection forbids exposing
child-identifying or targeting-enabling data.

## Decision

- **Personas as Postgres roles/claims:** `district_admin`, `ngo_member` (scoped to its
  assignments), `village_committee` (scoped to its village), `public`.
- **RLS on every table**; default deny. The `public` persona can only read aggregate
  **views** (counts, scores, fund totals per village) — never beneficiary rows, photos or
  follow-up records.
- Beneficiary read models expose the minimum: category counts per village publicly;
  identified records only to the assigned NGO and district roles.
- Orphaned-children records additionally restrict contact/location fields to
  `district_admin`.
- Media evidence (photos) is stored in private Supabase Storage buckets with signed URLs;
  public dashboards use aggregate imagery only.

## Consequences

- Transparency goals are met with aggregates; safeguarding is enforced at the database
  layer, not just the app layer.
- Every migration adding a table must ship its RLS policy in the same migration (checked in
  review).
