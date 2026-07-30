# ADR 0016 — In-app feedback: reports from the people using it, with the context attached

**Status:** Accepted — amended 2026-07-30, see the amendment at the end

## Context

Version 1 is released. The people who will find its faults are field workers, district officers and
citizens in Assam — not the person who built it, and not anyone with a GitHub account.

The gap this closes is specific. A user who hits a bug today has no route at all: no address in the
page, no form, no issue tracker they could reach. Their options are to tell somebody in person, or
to stop using the feature. Both lose the report.

Two constraints shape the design.

**Feedback is free text, and free text about this platform will contain personal data.** A useful bug
report reads *"the aid record for Rekha Das in Nazira shows twice"*. That is exactly the report we
want and exactly the sensitivity of the beneficiary registry (ADR 0009). Anything that treats
feedback as low-value operational chatter is wrong about what it will contain.

**A report without context is usually unactionable.** "It doesn't work" from an unknown role on an
unknown revision costs more to chase than it saves. What makes a report cheap to act on is the
things the user should not have to type: which build, which view, which role.

## Decision

**A `feedback` table in `assam_floods`, written through the API by signed-in users, readable by
administrators only.**

### Storage

```sql
assam_floods.feedback (
  id           text primary key,
  kind         text not null check (kind in ('bug','feature','other')),
  summary      text not null,
  detail       text,
  -- Context, captured automatically. The user types none of this.
  build_commit text,
  build_branch text,
  view_path    text,
  user_agent   text,
  -- Who, denormalised for the same reason as audit_log (ADR 0011)
  reporter_id    uuid,
  reporter_email text,
  reporter_role  text,
  status       text not null default 'open'
    check (status in ('open','acknowledged','resolved','declined')),
  created_at   timestamptz not null default now()
)
```

### Signed-in only

Anonymous submission is refused, and this is a real trade-off rather than an oversight. The public
transparency view is reachable without an account, so a visitor who spots a fault there cannot
report it.

Accepted because the alternative is worse in this specific deployment: an unauthenticated write
endpoint on a single-file page with no captcha, no rate limiter and no moderation queue is a spam
sink, and the first thing that fills it makes every genuine report harder to find. Everyone the PRD
describes as a *user* already needs an account to do anything beyond reading.

If public reporting is wanted later, the honest way is a moderation queue and a rate limit, not
simply removing the check.

### Administrators only, on the read side

Feedback inherits the beneficiary registry's sensitivity (see Context) and is therefore readable by
`admin` alone — not by `district_officer`, who can read the audit trail.

That is deliberately *narrower* than ADR 0011's audit access. The audit log's payloads are domain
events with known, structured fields; feedback is unbounded free text written by someone who has not
been told what not to include. A district officer has no operational need for other districts'
complaints, and the reader set for free-text PII should be the smallest set that can act on it.

### The form says what not to type

The submission form carries a visible line asking users not to include names or other personal
details, and to reference a village or record by its identifier instead.

This will be imperfectly obeyed, and it is not a control. It is there because the alternative —
saying nothing and then holding names we did not need — is worse, and because a user told *"use the
record id instead"* often will.

### Context is captured, location is not

`build_commit`, `build_branch`, `view_path` and `user_agent` are attached automatically. The commit
comes from the same `/health` stamp the footer renders, so a report can be tied to the exact
revision that produced it.

Deliberately **not** captured: geolocation, IP, or any identifier beyond the account already
signed in. A bug report is not a reason to learn where a field worker is standing.

### Status, and the absence of a workflow

`status` exists so an administrator can mark a report acknowledged or resolved. There is no
assignment, no comment thread and no notification. Those are the parts of an issue tracker that earn
their keep at a scale this platform is nowhere near, and building them now would produce a worse
GitHub with one user.

## Alternatives considered

**Open a GitHub issue via the API.** Tempting — the tracker already exists and the maintainer already
watches it. Rejected: it needs a token in the deployment that can write to the repository, it puts
whatever a user types (including names) into a public repository irrevocably, and GitHub's
availability becomes a dependency of the app's feedback path.

**A `mailto:` link.** Free, and rejected as close to useless on the target devices: it depends on a
configured mail client, loses every piece of context, and produces reports with no structure.

**A third-party widget.** Rejected on the same grounds as ADR 0012 rejected CDN tiles: it puts an
external script into a page that deliberately has none, and sends user-typed text — which will
contain beneficiary names — to a third party.

**Reuse the existing issue-tracking context.** `Issue` already models a reported problem, and it is
about a *village's* problem — a contaminated handpump — not about the software. Overloading it would
put "the recovery bar renders wrong" into the same register a district officer reads for flood
response, which is the more expensive confusion.

## Consequences

- Reports arrive with the revision attached, so "it worked yesterday" becomes checkable rather than
  a discussion.
- The table holds free text that will sometimes contain personal data despite the warning. It is
  admin-only, and it is subject to the same absent retention policy as the audit log (ADR 0011) —
  which remains a governance decision needing a human owner.
- No notification exists. An administrator has to look. For a platform with one administrator and a
  handful of users that is honest; it stops being honest the moment there are several.
- A public visitor cannot report a fault in the public view. That is a real gap, recorded here so it
  is a decision rather than a discovery.

---

## Amendment (2026-07-30) — feature requests are visible to every signed-in user

**Status of the amendment:** Accepted, and implemented.

### What prompted it

The maintainer filed a suggestion through the new form and asked the obvious next question: how does
anybody know what has already been suggested?

They cannot. As built, the queue is `admin` alone, so a suggestion box is write-only to everyone
except one person. That produces the same idea arriving five times, each reporter believing they are
the first, and none of them able to tell whether the thing they want is already agreed, already
built, or already declined. **A backlog only one person can read is not a backlog.**

### What is being changed, and what is not

`GET /feedback/suggestions` is readable by **any signed-in user**. It returns:

| Field | Why it is here |
|---|---|
| `summary` | Without it there is nothing to read. One line, capped at 200 characters |
| `status` | The whole point — "already declined" is as useful as "already agreed" |
| `createdAt` | Whether this is a live idea or a two-year-old one |
| `id` | So it can be referred to |

Everything else is **absent by construction**, via `toSuggestion`:

- **`detail`** — the long free-text box. This is where a name gets written, and it is exactly what
  the "Administrators only" section above is about. It never leaves the server on this path.
- **`reporterId` / `reporterEmail` / `reporterRole`** — an idea's merit does not depend on whose it
  was, and who complained about what is nobody else's business.
- **`buildCommit` / `buildBranch` / `viewPath` / `userAgent`** — diagnostics, useless to a reader,
  and `viewPath` discloses which part of the platform somebody was working in.

**Only `kind: "feature"`.** Bug reports and "other" stay `admin` alone, and the split is not
arbitrary. A feature request describes something the platform *does not do* — it is about the
software. A bug report describes something that *went wrong*, and the way anybody describes what went
wrong is by naming the record it went wrong on: *"the aid record for X shows twice"* is the useful
form of a bug report and the dangerous form of a public one.

Two consequences of restricting it to one kind are worth stating. No report filed before this
amendment has become visible unless it was already a feature request — nobody's private report was
made public retroactively. And the disclosure below is only ever shown for the kind it is true of, so
it does not become noise that gets ignored on the report where it matters.

### The disclosure is half the decision

The dialog now says, **above the summary field and only when the report is a feature request**, that
the line about to be typed will be visible to other signed-in users. Consent at the point of entry,
not in a policy page nobody opens. Without it this would be a change to what happens to somebody's
words after they have written them, which is the thing the original section was trying to prevent.

### Why the control is the shape, not the role

The original argument was about *free text written by somebody nobody has briefed*, and it still
governs `GET /feedback`, which is untouched. What changes here is that a strictly narrower projection
is exposed to a wider audience — so the safety comes from `toSuggestion` dropping everything by
construction, rather than from a route remembering to omit three fields. A route that spread the row
and deleted fields would leak the fourth one added next year.

This is enforced in two places rather than one: the store is asked for a single kind, *and* the
result is filtered again in the route. The second check is redundant today. It is there because this
is the one list non-admin readers see, and a bug report reaching it is the failure this endpoint has
to not have.

The frontend keeps the shared list and the admin queue as **two separate panels with two separate
gates** — `canReport()` and `canReadFeedback()`. One panel with a filter could be widened to the
whole table by changing the filter, which is precisely the mistake the split makes impossible.

### What is still true

Escaping now matters in a way it did not before: this is the **only** place on the platform where
text one user typed is rendered to another user. The API stores summaries verbatim — deliberately,
since mangling somebody's words is worse than escaping them at the point of display — which puts the
entire responsibility on the renderer, and a test holds it there.

There is still no moderation queue. A summary appears the moment it is filed, so a user could put
something objectionable in front of other users, and the only remedy is an administrator setting the
status to `declined` — which hides nothing, because `declined` items remain listed. If that becomes a
real problem the fix is an admin-visible-only default with an explicit "share" action, and it is not
built now because a moderation step on a platform with a handful of users would mean ideas sitting
invisible until somebody remembered to look.
