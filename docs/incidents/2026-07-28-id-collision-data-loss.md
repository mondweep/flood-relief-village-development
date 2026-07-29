# Incident — id reissue destroyed a village record and misattached its children

**Date detected:** 2026-07-29
**Date occurred:** 2026-07-28, ~22:09–22:10 UTC onward
**Status:** Cause fixed and deployed. **Data consequences deliberately left in place pending the owner's decision.**
**Severity:** High — silent destruction and fabrication of records on a platform whose purpose is that records do not vanish.

## What happened

`createPlatform()` defaulted its `IdGenerator` to `SequentialIdGenerator`, which lives in
`packages/shared-kernel/src/fakes.ts` because it is a **test fake**. It counts from zero in process
memory.

On Cloud Run with `min-instances=0` the container stops when idle. On restart the counter reset to
zero while Postgres kept every row. The next village registered was handed `village-1` again, and
the Supabase adapter's `save()` — an upsert by primary key — silently overwrote the existing row.

## Confirmed consequences

**1. A village record was destroyed.** A seeded village *Rampur* (Barpeta, `critical`) occupied
`village-1`. A village registered through the deployed app, *Village 1* (Sivasagar, `severe`), took
that id and overwrote it. Rampur's name, district, severity, population and coordinates are gone.
`created_at` still reads `2026-07-28 22:09:41` — Rampur's insert time — because the upsert only
overwrote the mutable columns, which is why the row does not look replaced.

**2. Its damage assessments were deleted.** The village adapter's `save()` reconciles child rows by
deleting and re-inserting them, so Rampur's assessment was removed when the new village was written
with none. `village_registry_damage_assessments` for `village-1` is empty.

**3. Records from other aggregates were misattributed, not deleted.** Beneficiaries, issues,
assignments and recovery history live in their own repositories, keyed by `village_id`. They were
untouched by the overwrite and therefore now point at a village they were never about. As of
2026-07-29 the following seeded records are attached to the owner's *Village 1* in Sivasagar:

| Kind | Record | Note |
|---|---|---|
| Beneficiary | Rekha Das (widow) | seeded demo record |
| Beneficiary | Arun Bora (orphan) | seeded demo record |
| Aid record | food, provider `ngo-1` | part of the duplicate-aid demonstration |
| Aid record | food, provider `district-admin` | the record that triggered the duplicate flag |
| Issue | `issue-1` water — "Handpump contaminated after flood" | seeded demo record |
| Issue | `issue-2` **corruption** — "Relief lists allegedly altered" | **seeded demo record; a fabricated allegation now attached to a real village** |
| Assignment | `assignment-1` → NGO `ngo-1` (Goonj), status `active` | seeded demo record |
| Recovery history | 2 entries, composite 0 then 31 | derived from the seeded scores |

The third consequence is the serious one. Deletion is visible; **fabrication is not**. The platform
currently reports that a widow and an orphaned child are registered in a village where they are not,
and that a corruption allegation was made about relief distribution there. Nobody reading the app
has any signal that these are wrong.

## Fix applied

`RandomIdGenerator` (`randomUUID()`, CSPRNG-backed) is now the production default — collision-free
without coordination, correct across restarts and across concurrent instances. Deployed in revision
`afrip-api-00005-9ll`.

Regression test: `packages/platform/test/id-generation.test.ts`. It asserts the property that was
actually violated — *a fresh platform never reissues an id an earlier platform used*, because a
restart is a fresh platform. Mutation-checked: reverting the default makes it fail.

The 11 API tests that broke had hardcoded `village-1`, `ngo-1` etc. That was diagnostic: they only
passed because a fake was the production default. Fixed by injecting `SequentialIdGenerator` in the
API test helper, where a fake belongs.

## What was NOT done, and why

The owner was offered three options — delete the misattached records, re-point them to a correctly
named demo village, or leave them — and chose to leave them and decide later. **No production rows
were altered.** This document exists so that decision can be made later with the full picture,
since the session that discovered it is ephemeral.

The records above are identifiable by `village_id = 'village-1'` combined with a `created_at`
between `2026-07-28 22:09:41` and `22:10:17` UTC.

## Why recovery is not possible from within the platform

The obvious question — *can the event stream reconstruct Rampur?* — has an unwelcome answer.
`VillageRegistered` was emitted at the time and carried the data, but domain events are published to
an **in-process bus and then discarded**. `domain_events_outbox` exists and is empty; it has never
been written to. Nothing persisted the event.

That is precisely the gap ADR 0011 addresses, and this incident is the strongest argument for it:
had the audit log existed, Rampur would be fully reconstructible from `village.registered.v1` and
this document would be a recovery procedure rather than a post-mortem.

## Lessons

1. **A class named `SequentialIdGenerator` in a file named `fakes.ts` was the production default.**
   The naming said what it was; nothing enforced it. Test doubles and production implementations
   should not be reachable through the same default.
2. **Upsert-by-primary-key turns an id collision into silent data loss.** A create path that
   collides should fail loudly. Distinguishing insert-from-update in the adapters is unfinished work
   and would have converted this into an error instead of an overwrite.
3. **Tests asserting `village-1` were coupled to the bug.** They passed *because* production used a
   fake, so the suite could never have caught it.
4. **Fabrication is worse than deletion and harder to notice.** The lost village was discovered
   quickly; the misattached beneficiaries and the corruption allegation would have gone unnoticed
   indefinitely, because they render as ordinary data.
