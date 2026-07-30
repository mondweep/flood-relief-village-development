# ADR 0017 — Rehearse the migrations, rather than build a staging environment

**Status:** Accepted

**Amends the "Environments" section of the README, which until now said staging did not exist and
left it there.**

## Context

Changes reach production by one route: a developer runs `scripts/deploy-cloudrun.sh` on their own
machine. Since ADR 0016's release that route is gated — typecheck, then the suite, then the bundle —
so a broken commit no longer ships. Nothing between that gate and the live service validates
anything.

The obvious next step is a staging environment, and it was assessed rather than guessed:

- **The application half is nearly free.** `SUPABASE_SCHEMA` is already parameterised, so staging is
  a second Cloud Run service pointed at `assam_floods_staging`. Roughly an hour.
- **The identity half is not.** Supabase Auth (GoTrue) is per *project*, not per schema, so staging
  and production would share one user pool. Only `user_profiles` is schema-scoped, so a person could
  hold `admin` in staging and `citizen` in production — which is workable but is a second set of
  role facts to keep straight, on the platform whose founding complaint is that records cannot be
  trusted.
- **And it would validate the thing that is already cheapest to undo.** A bad revision is one
  `gcloud run services update-traffic` away from the previous one. Nothing about the application
  layer is irreversible.

That last point is what decided this. Asked which change here has no undo, the answer is not the
code — it is the schema. `drop column` takes the data with it. This project has already lost a
village record it could not recover (see [docs/incidents/](../incidents/)). A staging environment
built to protect the reversible half, while migrations continued to go straight to production
unrehearsed, would be effort spent in the wrong place and — worse — would *read* as protection.

## Decision

**Rehearse every migration against a real, empty PostgreSQL before production sees it. Do not build
a staging environment yet.**

`scripts/check-migrations.sh` runs three checks, cheapest first, and is the last stage of the deploy
gate:

1. **Numbering.** Files are `NNNNN_name.sql`, unique and contiguous. A gap or a duplicate number
   means the order the schema builds in is decided by glob order rather than by intent.

2. **Append-only.** A sha256 per file in `supabase/migrations.sha256`, committed. Editing a migration
   that has already been applied does not change the database it ran against — it changes only what a
   *fresh* database would build, so the two diverge silently and every later migration is written
   against a schema that exists in exactly one of the two places.

   `--record` appends new files. It deliberately **cannot** update a changed hash: fixing that
   requires editing the manifest by hand, which is the friction the check is made of.

3. **Rehearsal.** Apply every migration to an empty database, then apply the whole set **again** over
   the result. The second pass is not a formality — migrations get re-run when a deploy is retried or
   somebody applies the folder rather than the one new file, and every migration here is written to
   survive that (`if not exists`, `or replace`, `drop policy if exists` before `create policy`). That
   property is invisible on the first pass, when everything is being created anyway. A bare
   `create table` slipping in is caught only by pass 2, and that was verified by adding one.

   The database is `MIGRATION_REHEARSAL_URL` if set, otherwise a throwaway cluster `initdb`'d into a
   temporary directory with no TCP listener at all.

The CI workflow runs the rehearsal as its own job against `postgres:17` — matching what the Supabase
project reports — because that is the one place `SKIP_REHEARSAL=1` is not honoured.

## What this deliberately does not prove

Stated here because a check believed to cover more than it does is worse than no check.

- **It is not Supabase.** `auth.uid()`, `auth.jwt()` and the `anon` / `authenticated` /
  `service_role` roles are stubbed. So the DDL is valid and the grants and policies attach to
  something; **nothing here proves an RLS policy admits the right rows.** The stub bodies return
  null, so a policy evaluated against them matches nothing — the safe direction for a stub to be
  wrong in, and still a stub.
- **The database is empty. Production is not.** A migration that succeeds here can still fail there
  on a `not null` added to a column holding nulls, or a unique index over duplicate rows. Rehearsing
  against a restored copy of production data is the next increment and is not this.
- **It says nothing about locks.** A migration that applies in 40ms on an empty table can hold a real
  one offline for minutes.

## Consequences

**Migrations become the slowest part of the deploy gate**, because it starts a database. That is the
right thing to spend seconds on: it is the only stage guarding a change that cannot be taken back.

**Editing an applied migration now fails the build.** This will be inconvenient exactly once per
person, and the inconvenience is the point. The fix is always to write a new migration.

**A developer with no PostgreSQL installed gets a partial check.** `SKIP_REHEARSAL=1` drops the third
check and keeps the first two, warning that nothing has proved the SQL runs. CI does not honour it.

**Staging is deferred, not rejected.** The assessment above stands and the application half remains
about an hour's work. What has changed is the ordering: the irreversible half is now covered, so
building the reversible half is a judgement about convenience rather than about risk. The honest
statement — in the README, in the words a reader would use — is that this platform has no staging
environment, and that its migrations are rehearsed.
