-- AFRIP 00003 — lifecycle timestamps that 00001 dropped on the floor.
--
-- The Issue aggregate records WHEN each transition happened (route /
-- startProgress / verify), but 00001_initial_schema.sql only gave it columns for
-- the routing decision and the resolution. A save/load round trip therefore lost
-- routedAt, progressStartedAt and verifiedAt: the aggregate came back with the
-- right status and no idea when it got there. These three nullable columns close
-- that gap. They are nullable because they are genuinely absent for an issue
-- that has not reached the corresponding state yet.
--
-- ngo_coordination_assignments.retired_at ALREADY EXISTS (00001) and is
-- deliberately not re-added here. It stays unwritten for a different reason: the
-- VillageAssignment aggregate's retire() takes no timestamp and exposes none, so
-- there is no instant to persist. Writing one would mean inventing it. Closing
-- that gap is a domain change (retire(occurredAt)), not a schema change.
--
-- Schema-qualified like every other AFRIP migration: the target project's
-- `public` schema belongs to other applications (see 00001).
--
-- Idempotent: `add column if not exists` so re-running against an already
-- migrated database is a no-op.

alter table assam_floods.issue_tracking_issues
  add column if not exists routed_at timestamptz null;

alter table assam_floods.issue_tracking_issues
  add column if not exists progress_started_at timestamptz null;

alter table assam_floods.issue_tracking_issues
  add column if not exists verified_at timestamptz null;
