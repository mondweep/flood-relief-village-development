# ADR 0013 — Viewing and amending a village: correction is not the same as change

**Status:** Accepted — implemented

> **Implementation note.** Delivered as specified, with one honest shortfall: the history timeline
> (decision 1) is thin. `GET /villages/:id/history` returns only what is genuinely persisted today —
> damage assessments and recovery-score history. Severity transitions and profile corrections emit
> events carrying both sides of the change, but nothing stores them, so the route returns fewer
> entries rather than synthesising any. It gains those kinds when ADR 0011's audit log lands, at
> which point the route reads the event stream and the response envelope simply grows more `kind`
> values.

## Context

Clicking a village in the dashboard does nothing. The data is not missing —
`GET /villages/:id` exists and returns the full profile including damage assessments — but no
frontend view consumes it. The platform can answer "tell me everything about Rampur" and has no
way to ask.

Behind that is a second, deeper gap. `Village.updateDemographics()` exists on the aggregate,
validated and tested, and **nothing calls it**: there is no use case and no route. So a village
registered with a mistyped population cannot be corrected through any interface. The only mutations
reachable today are `PATCH /villages/:id/severity` and `POST /villages/:id/damage-assessments`.

The request — *"I may want to edit entries I registered the village with, or the impact on the
village may have reduced"* — contains two different needs in one sentence, and the difference
matters more than it first appears:

- **"I typed 1200 but it is 1240."** The world did not change. Our record of it was wrong.
- **"The flooding has receded; severity is now moderate."** The record was right. The world moved.

A conventional `PUT /villages/:id` serves both and destroys the distinction. After a naive edit
lowering severity from `critical` to `moderate`, nothing in the system can say whether the village
recovered or was never critical. For a platform whose founding complaint is that nobody can later
reconstruct what happened, that is not a small loss — it is the loss.

The existing model already has the right instinct in places. `updateSeverity` returns the previous
value and emits it. Damage assessments are append-only: you do not edit last week's assessment, you
record this week's. The decision below generalises what is already half-built rather than inventing
something new.

## Decision

### 1. A village detail view, deep-linkable

A first-class view at `#/villages/:id`, reachable by tapping any village anywhere in the app, and
shareable as a URL. It shows the profile, the assigned NGO and committee, the recovery index across
its eleven dimensions, beneficiaries, issues, projects, and — the part that matters here — **the
village's history as a timeline**: every assessment, severity change, correction and assignment, in
order, attributed.

That timeline is the visible payoff of the event stream (ADR 0005) and the audit trail (ADR 0011).
Until now those existed and nobody could see them.

### 2. Three kinds of amendment, kept distinct

No `PUT /villages/:id`. No generic overwrite. Instead the API keeps saying which of three things is
happening:

| Kind | Route | Semantics |
|---|---|---|
| **Observation** — the world changed, record it | `POST /villages/:id/damage-assessments` *(exists)* | Append-only. Never edits a prior assessment. |
| **Transition** — a classified state changed | `PATCH /villages/:id/severity` *(exists)* | Records `previous` alongside the new value. |
| **Correction** — our record was wrong | `PATCH /villages/:id/profile` **(new)** | Requires a stated `reason`. Emits before *and* after. |

The new correction route is backed by a new `CorrectVillageProfile` use case over the existing
`updateDemographics`, emitting `village.profile-corrected.v1` carrying `{ changed: {field: {from,
to}}, reason }`.

**`reason` is required**, and this is deliberate friction. An unexplained correction to a
population figure is indistinguishable from a mistake or a manipulation six months later; a
one-line reason is cheap to write and is the only thing that makes the audit trail interpretable.
It is a text field, not an enum — the interesting reasons are the ones we did not anticipate.

### 3. Severity reductions are transitions, not corrections

"The impact has reduced" routes to the existing `PATCH /villages/:id/severity`, which already
preserves `previous`. The detail view should make this visible as a progression
(`critical → severe → moderate`) rather than a field that happens to hold a different value than it
used to.

### 4. Where amendment is refused

Damage assessments are **not** editable. A wrong assessment is superseded by recording a new one,
which is how the physical world works: you do not un-observe a flood. If the ability to retract a
mistaken assessment proves genuinely necessary, it should arrive as an explicit
`RetractDamageAssessment` that marks and explains, never as a mutation of the original row.

Deletion of a village is not offered to anyone, including admins, at this stage.

### 5. Who may amend

Per ADR 0009: the creator may correct their own entries; `district_officer` and `admin` may correct
any; `ngo_coordinator` may amend villages they are assigned to. Every amendment is attributed via
ADR 0010 and lands in the audit log via ADR 0011 — which is what makes required `reason` worth
collecting rather than merely bureaucratic.

## Alternatives considered

**`PUT /villages/:id` with a full replacement body.** Conventional REST, one route, familiar to
every client developer. Rejected as the central mistake this ADR exists to avoid: it cannot express
*why* a value changed, and it makes correction and real-world change indistinguishable in both the
API and the audit log.

**`PATCH /villages/:id` accepting any subset of fields.** Better — smaller payloads, no accidental
clobbering. Still rejected, because it flattens the same three semantics into one verb. The
distinction lives in *which route you call*, and that is precisely what makes the audit trail
readable later.

**Infer correction-versus-change from which fields moved.** Tempting: severity implies transition,
population implies correction. Rejected because the inference is wrong exactly where it matters —
population genuinely changes when a village is displaced, and severity can genuinely be
mis-entered. Guessing intent from field names would silently mislabel the interesting cases.

**Full temporal versioning of the aggregate** (every version retained, queryable as-of a date). The
most complete answer, and where a platform tracking multi-year recovery may eventually need to go.
Rejected as disproportionate now: the event stream already reconstructs history, and versioning
every aggregate is a persistence-layer rewrite. This decision keeps that door open by ensuring the
events carry both sides of every change.

**Make the detail view read-only for now.** Would close the reported gap — nothing happens on
click — with a fraction of the work. Rejected because the second half of the request (correcting
what was registered) is currently impossible through *any* interface, and a detail view that
displays a wrong population without letting anyone fix it is a worse experience than no view at all.

## Consequences

- `CorrectVillageProfile` is the first use case in the platform to require a human-supplied
  justification. If the pattern is right, aid records and fund figures will want it too — and it
  should be a shared value object rather than a string on one use case.
- `village.profile-corrected.v1` carries before/after, which is exactly the shape ADR 0011 noted
  was missing from most mutation events. This becomes the worked example for retrofitting the rest.
- The detail view needs data from six contexts for one village. Today that is six round trips; if
  it becomes slow, the answer is a read projection assembled server-side, not a cross-context join
  in the domain (ADR 0001).
- **A modelling smell surfaced and is deliberately not fixed here:** `affectedFamilies` lives on
  `Village` as though it were a baseline fact, but it is an *observation* that changes as relief
  progresses — it belongs with damage assessments. Moving it is a domain change with migration
  consequences; recording it here so the next person meets a documented smell rather than a
  surprise.
- Required `reason` will be resisted as friction, and some users will type "correction". That is
  acceptable: even a poor reason records that someone chose to change a number and knew it was
  recorded.
