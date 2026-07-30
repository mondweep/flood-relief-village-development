-- AFRIP demonstration data
--
-- WHAT THIS ADDS, AND WHY IT IS A COLUMN RATHER THAN A CONVENTION
-- ---------------------------------------------------------------------------
-- Some village records exist so the platform can be SHOWN to someone: seeded
-- rows, with seeded beneficiaries, seeded issues and seeded scores hanging off
-- them. Nothing in the database says so. They render as ordinary measurements,
-- they are summed into every published total, and the only thing separating
-- them from a real village is that somebody remembers which is which.
--
-- `docs/incidents/2026-07-28-id-collision-data-loss.md` is what that costs. An
-- id collision re-pointed a set of seeded records — two beneficiaries and a
-- CORRUPTION ALLEGATION among them — at a real village registered through the
-- deployed app, and the incident's closing lesson is the reason this column
-- exists: "fabrication is worse than deletion and harder to notice." A deleted
-- record leaves a hole somebody trips over. A fabricated one is read, believed
-- and acted on.
--
-- So the fact goes in the schema, where a query can find it:
--   select * from assam_floods.village_registry_villages where is_demonstration;
-- rather than in a naming convention someone has to remember, which cannot be
-- queried, cannot be joined and is wrong the first time a demo village is
-- renamed.
--
-- Mirrors `Village.isDemonstration` in
-- `packages/village-registry/src/domain/village.ts`.
--
-- Idempotent throughout: `add column if not exists`, `create or replace
-- function`, and the trigger dropped before being recreated (Postgres has no
-- `create trigger if not exists`). Re-running this file is a no-op.
--
-- No new grants are needed: 00002 grants on the TABLE, and a column inherits
-- them. No RLS change either — the policies in 00002/00005 select whole rows,
-- so the new column is covered by the existing "authenticated read villages"
-- policy without restating it, and the public projections are served by the API
-- rather than by a view that would need widening.

-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------
-- `not null default false`, which is the OPPOSITE judgement to 00007's
-- deliberate refusal of a default on `geo_source`, so it is worth saying why
-- rather than leaving the inconsistency to look like carelessness.
--
-- A default is dangerous when it MANUFACTURES a fact — `default 'manual_entry'`
-- makes every forgetful insert assert that a human typed those coordinates.
-- `default false` manufactures nothing. "This record is not a demonstration" is
-- the state of every row that nobody has deliberately marked, and it is the
-- state the platform must fall back to: a record wrongly treated as real is
-- visible and arguable, while a real village wrongly treated as demonstration
-- would silently vanish from every published figure, which is the failure mode
-- that is hard to see. False is both the honest default and the safe one, which
-- is a rare enough combination to take.
--
-- Not null for the ordinary reason: a three-valued flag would put "we do not
-- know whether this is real" into a schema whose whole purpose here is to
-- answer that question.
alter table assam_floods.village_registry_villages
  add column if not exists is_demonstration boolean not null default false;

comment on column assam_floods.village_registry_villages.is_demonstration is
  'True when this record exists to be looked at, not believed: demonstration '
  'data, excluded from every published aggregate and labelled wherever it '
  'appears. One-way — see the trigger below.';

-- ---------------------------------------------------------------------------
-- NO BACKFILL, DELIBERATELY
-- ---------------------------------------------------------------------------
-- This file adds the column and stops. The existing seeded rows are NOT flagged
-- here.
--
-- That is not an omission and it is not squeamishness. Flagging those four rows
-- is bound up with renaming and relocating the records the 2026-07-28 incident
-- misattributed, and the platform owner is doing that as one deliberate,
-- visible change. An `update ... set is_demonstration = true where id in (...)`
-- buried in a migration would make the most consequential edit to the live data
-- the least visible thing in this file — and it would run again, silently, on
-- any environment that replays the migrations with different rows behind those
-- ids.

-- ---------------------------------------------------------------------------
-- The flag is ONE-WAY, for every role including service_role
-- ---------------------------------------------------------------------------
-- Setting it says "do not believe this record". Clearing it would say "believe
-- it after all" — which is not a correction of a mistake but a laundering of a
-- fabricated record into the real reporting, and it would leave no trace: the
-- row would simply start being counted.
--
-- The application already cannot do it. `Village` has no method that clears the
-- flag, so there is no use case, no route and no request body that reaches it.
-- This trigger is the second line, for the door the application does not own:
-- PostgREST with a leaked key, a hand-written `update` at a psql prompt, an
-- adapter bug that reconstructs a village without its flag and upserts it back.
-- The last of those is the realistic one, and this turns it from a silent
-- downgrade into a loud failure — which is lesson 2 of the same incident, where
-- an upsert that should have failed instead overwrote.
--
-- Same shape and same trade-off as `record_ownership` in 00005: append-only for
-- everyone, with the repair path deliberately outside the application. A row
-- flagged in error is fixed by a superuser who disables this trigger, which
-- leaves a trace in the Postgres logs and cannot be reached from a key.
--
-- Note what is NOT blocked: false -> true (that is the operation), true -> true
-- and false -> false (an upsert re-writing the same value, which the adapter
-- does on every save), and DELETE, which is a different act with different
-- consequences and is governed by whoever may delete villages at all.
create or replace function assam_floods.village_demonstration_is_one_way()
returns trigger
language plpgsql
as $$
begin
  if old.is_demonstration and not new.is_demonstration then
    raise exception
      'village % is demonstration data; the flag cannot be cleared (see migration 00008)',
      old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function assam_floods.village_demonstration_is_one_way() from public;

drop trigger if exists village_demonstration_is_one_way
  on assam_floods.village_registry_villages;
create trigger village_demonstration_is_one_way
  before update on assam_floods.village_registry_villages
  for each row
  execute function assam_floods.village_demonstration_is_one_way();

-- ---------------------------------------------------------------------------
-- No index, and why
-- ---------------------------------------------------------------------------
-- "Which villages are real?" is `where not is_demonstration`, and it will
-- sequential-scan. That is the right plan for the same reason 00007 gives: this
-- table holds four rows today and is bounded by the number of villages in
-- Assam. A boolean column is also close to the worst case for a b-tree — two
-- distinct values means the planner will usually prefer the scan anyway. Add a
-- partial index when the table is large enough for the planner to want one, not
-- now on the strength of the query existing.
