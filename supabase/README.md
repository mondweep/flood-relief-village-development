# AFRIP Supabase (primary data store — ADR 0004)

Migrations in `migrations/` are the deployable schema for all nine bounded contexts, plus the
domain-event outbox and public transparency views.

## Provisioning

Creating a Supabase project incurs a cost that needs explicit confirmation by the account owner.
Once a project exists (e.g. `afrip-platform` in the existing organization):

```bash
# via Supabase CLI
supabase link --project-ref <ref>
supabase db push          # applies migrations/ in order
```

or apply each file through the Supabase MCP `apply_migration` tool.

## Design notes

- Each bounded context owns its tables (context prefix); cross-context access goes through
  application ports, never SQL joins across contexts (except read-only public views).
- Cheap domain invariants are duplicated as SQL constraints (defence in depth): e.g.
  `spent_minor <= released_minor <= sanctioned_minor`, and the flagship
  `one_active_assignment_per_village` partial unique index.
- RLS is enabled on every table; the public (anon) role can only read the pseudonymised
  `public_village_recovery` and `public_fund_transparency` views.
- Until a project is provisioned, all tests run against in-memory adapters (ADR 0003).
