# ADR 0014 — Membership is explicit: no auto-enrolment on a shared Supabase project

**Status:** Accepted
**Amends:** ADR 0008 (Supabase Auth for identity)

## Context

ADR 0008 chose Supabase Auth and assumed, without saying so, that the people in `auth.users` are
AFRIP's users. On this deployment that assumption is false.

The Supabase project `ertsvhwtaeityanbmyzw` is **shared with four unrelated applications**, and
GoTrue's user pool is per-**project**. `auth.users` is therefore not AFRIP's table; it is everyone's.
Measured on 2026-07-29 it held **22 accounts, none of them AFRIP's**.

The implementation of ADR 0008 mirrored the two tables with an `after insert` trigger on
`auth.users`. On a project AFRIP owned alone that is the obvious design. Here it meant every signup
to a neighbouring application created an AFRIP `citizen` — and before ADR 0009, `citizen` meant full
API access, including the beneficiary register: the names, household composition and aid history of
widows and orphaned children.

Two facts make the situation better than it sounds and one makes it worse.

Better: **the migration was never applied.** Verified against the live database before any of this
work — no `user_profiles`, no `role_grants`, zero non-internal triggers on `auth.users`. Nobody was
ever enrolled by it. And ADR 0009 has since landed, so `citizen` is a floor rather than a skeleton
key.

Worse: **the credential pool cannot be fixed from inside our schema.** All 22 accounts share our
issuer, our audience and our signing key, because they share the project. Any of them can mint a
token our verifier accepts. Nothing we write in `assam_floods` changes that.

The owner's requirement, stated plainly: *only users of the current app should have access; those
belonging to other apps should not get access by default.*

## Decision

**A `user_profiles` row is created only by a deliberate act.** The trigger is removed, not scoped.
Rows appear by exactly two paths:

1. `assam_floods.enrol_user(...)`, called by the API when someone completes AFRIP's own registration
   through `POST /me/enrolment`. This is the ordinary path.
2. The `role_grants` backfill, so the administrator exists in every environment regardless of
   whether their signup precedes or follows the deploy. `role_grants` is version controlled, so the
   set of people this can enrol is a set a reviewer has already agreed to.

Self-registration stays open, as ADR 0008 requires. It simply stops being a side effect of signing
up somewhere else.

`POST /me/enrolment` is the one route reachable with a verified token and no profile — it cannot
demand the profile it exists to create. Every other route refuses such a request with
`401 user_unknown`.

### Signing up enrols; signing in does not

The frontend auto-enrols after **registration** through AFRIP's own form, which is an unambiguous
request to join. It does **not** auto-enrol after **sign-in**: that account may belong to a
neighbouring application, and enrolling it automatically would be the trigger again, moved from the
database into the browser. Those users are offered the choice instead.

Google sign-in gets the offer rather than auto-enrolment, because a first-time and a returning user
are indistinguishable on that path.

### Provenance instead of a gate

`user_profiles` records `enrolled_at`, `enrolled_via` and `auth_created_at`. The last is the age of
the GoTrue account at the moment of enrolment: an account created eight months before it enrolled in
AFRIP is almost certainly a neighbour who wandered in; one created seconds before is an ordinary new
signup.

This is **evidence, not a gate**, and deliberately so. Any threshold would also catch a legitimate
user who signed up yesterday and came back to register today. Make the difference visible; let a
human judge.

## What this does not achieve

Stated here because every comment in the code points at this section, and because a partial fix
described as a complete one is worse than no fix.

**The shared credential pool is untouched.** Any of the 22 accounts can still visit AFRIP and
register themselves as a citizen. What is removed is *passive* enrolment — being made an AFRIP user
without ever having heard of AFRIP.

The only complete fix is a Supabase project dedicated to AFRIP, where `auth.users` is AFRIP's own
and a neighbouring user cannot authenticate at all rather than merely being refused. That was
offered and declined in favour of staying on the shared project; the data to move was ~20 rows, so
the cost was small and the decision was about operational overhead, not migration difficulty.

If the threat model ever includes a deliberate insider from a neighbouring team, this ADR does not
address it and should be revisited.

## Alternatives considered

**Scope the trigger to signups that identify themselves as AFRIP's.** Rejected. Signup metadata is
written by the user, so it bounds accidental enrolment and not deliberate enrolment — and it would
read like a control while being a convention.

**Invitation only: profiles solely from `role_grants`.** Safest within the shared project, and
rejected because it contradicts ADR 0008's requirement that people can register themselves. It
remains the right answer if the platform ever handles real beneficiary data at scale.

**Self-registration with administrator approval.** Satisfies both requirements — anyone may ask, and
nobody gets in until a human agrees. Rejected for now as more machinery than the current stage
justifies (a pending state, an admin list, approve/deny endpoints and UI). This is the natural next
step if the current arrangement proves too open, and is cheaper to add than a project migration.

**A dedicated Supabase project.** The complete fix. Declined by the owner; see above.

## Consequences

- Holding a valid token and being an AFRIP user are now different things, and the API says so with a
  distinct `user_unknown` code the frontend turns into an offer to register.
- A verified-but-unenrolled request reaches a handler with no actor, and a null actor **allows**
  every use case in `authorizePlatform` — a rule that exists for the legacy shared token, which is
  gated elsewhere. `UNENROLLED` was added to deny everything for this case. Nothing depends on it
  today, since the enrolment handler touches no use case; it exists so the next route added to
  `IDENTIFIED_ONLY_PATHS` does not inherit an unrestricted platform in silence.
- Enrolment is idempotent and never resets a role, so a district officer who registers again is not
  demoted. This is enforced in SQL (`on conflict do nothing` plus a read-back), not only in the API.
- An administrator can review enrolments, but nothing prompts them to. A periodic review of
  `user_profiles` ordered by `enrolled_at - auth_created_at` is warranted and does not exist.
- The 22 existing accounts have **no** AFRIP profile and will not acquire one passively. Verified on
  the live database after applying the migration.
