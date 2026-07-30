# ADR 0016 — In-app feedback: reports from the people using it, with the context attached

**Status:** Accepted

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
