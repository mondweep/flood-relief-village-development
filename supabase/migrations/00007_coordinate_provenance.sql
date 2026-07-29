-- AFRIP coordinate provenance (ADR 0012 §1)
--
-- WHAT THIS ADDS, AND WHY IT IS NOT COSMETIC
-- ---------------------------------------------------------------------------
-- `village_registry_villages` records a lat/lng and nothing about where it came
-- from. A GPS fix taken standing in the village and a geocoder's guess from a
-- name are both "a latitude and a longitude", and the table cannot tell them
-- apart. That difference is operational, not bookkeeping: a district officer
-- deciding where to send a boat needs to know which positions were surveyed and
-- which were inferred. For rural Assam the inferred ones are frequently wrong —
-- village names repeat across districts, transliteration varies, and many small
-- chapori settlements are in no gazetteer at all (ADR 0012 §Context 1).
--
-- Three columns follow: how the position was obtained, how accurate the device
-- claimed to be, and when it was taken.
--
-- Idempotent throughout: `add column if not exists`, a backfill guarded on
-- `is null`, `set not null` (a no-op when it already holds) and constraints
-- dropped before being recreated — Postgres has no `add constraint if not
-- exists`. Re-running this file is a no-op.
--
-- No new grants are needed: 00002 grants on the TABLE, and a column inherits
-- them. No RLS change either — the policies in 00002/00005 select whole rows,
-- so the new columns are covered by the existing "authenticated read villages"
-- policy without restating it.

-- ---------------------------------------------------------------------------
-- The columns
-- ---------------------------------------------------------------------------
-- Added nullable so the backfill below has something to fill; `set not null`
-- comes after it, once every row honestly has a value.
alter table assam_floods.village_registry_villages
  add column if not exists geo_source text;

-- Device GPS reports an accuracy; a map pin, a geocode and a typed number do
-- not. Hence nullable, with a positive check rather than a non-negative one: an
-- accuracy of zero metres is not a very good fix, it is a broken reading.
alter table assam_floods.village_registry_villages
  add column if not exists geo_accuracy_metres double precision;

-- When the position was taken, which is not `created_at`: a village registered
-- today may carry a GPS fix recorded in the field last week. Nullable because
-- the four existing rows have no such moment to record — see the backfill note.
alter table assam_floods.village_registry_villages
  add column if not exists geo_captured_at timestamptz;

-- ---------------------------------------------------------------------------
-- Backfill: the existing rows are `manual_entry`, because that is what they are
-- ---------------------------------------------------------------------------
-- These coordinates were typed into a form by somebody who did not stand in the
-- village. `manual_entry` is the lowest trust level in ADR 0012's ordering
-- (device_gps > map_pin > geocoded > manual_entry), and labelling them that way
-- is the honest reading, not a pessimistic one. The alternative — inventing a
-- higher provenance so the map looks better — is the exact failure this whole
-- decision exists to prevent.
--
-- `geo_captured_at` is deliberately left NULL for them. We know these positions
-- were typed; we do not know when they were observed, and `created_at` is when
-- the ROW was written, which is a different fact. Copying it across would
-- manufacture a survey timestamp out of an insert timestamp.
--
-- Guarded on `is null` so a re-run touches nothing, and so a row inserted
-- between the two runs keeps whatever provenance it was given.
update assam_floods.village_registry_villages
  set geo_source = 'manual_entry'
  where geo_source is null;

-- ---------------------------------------------------------------------------
-- NOT NULL, and deliberately NO DEFAULT
-- ---------------------------------------------------------------------------
-- This is the judgement call in the file, so here is the reasoning rather than
-- just the result.
--
-- A `default 'manual_entry'` would be convenient: it makes `set not null`
-- trivially safe and it stops any future insert from failing. That convenience
-- is precisely the hazard. A default does not record a fact, it MANUFACTURES
-- one — every insert that forgets the column would silently assert "a human
-- typed these numbers", which is worse than the ambiguity we are removing,
-- because a wrong label is harder to find than a missing one. ADR 0012 §1
-- rejects an optional `source` for the same reason at the type level; a column
-- default is that same defaulting, moved into the database where the type
-- system cannot see it.
--
-- With no default, an insert that omits `geo_source` fails loudly at the point
-- the mistake is made. The application never relies on the default anyway:
-- `GeoCoordinates.source` is required in TypeScript, so `toRow` always writes
-- the column. Nothing is gained by the default except the ability to get it
-- wrong quietly.
--
-- The backfill above is what makes this safe: every existing row already has a
-- value by the time this runs.
alter table assam_floods.village_registry_villages
  alter column geo_source set not null;

-- ---------------------------------------------------------------------------
-- The four values, and nothing else
-- ---------------------------------------------------------------------------
-- Mirrors COORDINATE_SOURCES_BY_TRUST in
-- `packages/village-registry/src/domain/village.ts`. Adding a source means
-- changing both, and this constraint is the one that will catch you — the same
-- arrangement 00005 uses for `record_ownership.record_type`.
--
-- The ORDER of the four is meaningful in the application (it is the trust
-- ordering) and meaningless to Postgres, which only checks membership. The
-- ordering is not encoded here on purpose: an integer rank column would have to
-- be kept in step with the TypeScript list on every read, and a check
-- constraint cannot express "more trusted than".
alter table assam_floods.village_registry_villages
  drop constraint if exists village_registry_villages_geo_source_check;
alter table assam_floods.village_registry_villages
  add constraint village_registry_villages_geo_source_check
  check (geo_source in ('device_gps', 'map_pin', 'geocoded', 'manual_entry'));

alter table assam_floods.village_registry_villages
  drop constraint if exists village_registry_villages_geo_accuracy_check;
alter table assam_floods.village_registry_villages
  add constraint village_registry_villages_geo_accuracy_check
  check (geo_accuracy_metres is null or geo_accuracy_metres > 0);

-- ---------------------------------------------------------------------------
-- No index, and why
-- ---------------------------------------------------------------------------
-- "Which villages still need a surveyed position?" — the query ADR 0012
-- §Consequences wants on a district dashboard — is
--   where geo_source in ('geocoded', 'manual_entry')
-- and it will sequential-scan. That is the right plan: this table holds four
-- rows today and is bounded by the number of villages in Assam, so an index
-- would cost writes and buy nothing measurable. Add one when the table is large
-- enough for the planner to want it, not now on the strength of the query
-- existing.
