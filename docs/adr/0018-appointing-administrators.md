# ADR 0018 — More than one administrator: provenance, not a sixth role

**Status:** Accepted — implemented

**Extends ADR 0009 (roles and ownership) and ADR 0008's `role_grants` bootstrap.**

## Context

The platform has had exactly one administrator since it was built, because the only way to become one
is a row in `assam_floods.role_grants` and the only way to add a row is a migration and a deploy.

That is genuinely good in one respect and untenable in another. Good: every appointment is a diff
somebody reviewed, and "who is an administrator" is answerable by reading this repository. Untenable:
every appointment blocks on the one person who can deploy, which does not survive the platform being
used by more than a handful of people.

The maintainer asked for one of two things: a super-admin model where they retain control and others
get privileged access, or fully decentralised administration by a group of trusted admins.

### The fact that decides it

**`admin` on this platform is not a role with more permissions. It is a role that is not checked.**
`authorizePlatform` admits an administrator *before* consulting the policy table, so `admin` appears
in none of the 48 rules. An administrator therefore holds the beneficiary register — the names of
widows and orphaned children — the audit trail, and every reported bug, not by grant but by absence
of a check.

The second fact, which reframes the request: **a `district_officer` already has all 32 workflows.**
Admin adds the feedback queue, marking demonstration data, and the bypass. So most of what "let other
people run the platform" means is not an admin at all.

Fully decentralised administration was therefore refused. Handing out an unchecked credential, with
every holder able to hand it out again and no in-app way to take it back, is a decision that one
mistake cannot be undone from — and the recovery path would be a migration, which is the exact
bottleneck this is meant to remove, hit at the worst possible moment.

## Decision

**Roles gain provenance. The provenance decides who may appoint.**

Migration 00010 adds `user_profiles.role_source`:

| Source | Meaning |
|---|---|
| `grant` | Asserted by `role_grants` — a migration, in version control, reviewed. An `admin` from this source is a **super admin** |
| `appointed` | Set in-app by a super admin |
| `self` | Nobody assigned it — the `citizen` floor from self-registration |

`isSuperAdmin(actor)` is `role === "admin" && roleSource === "grant"`, and it is the gate on both new
routes:

- `GET /admin/users` — everyone registered, with their role and its provenance
- `PATCH /admin/users/:id/role` — change somebody's role

**An administrator appointed in-app can do everything an administrator does except appoint another
one.** So the set of people who can hand out unchecked access stays exactly the set named in this
repository, and cannot grow by somebody clicking.

### Not a sixth role

A `super_admin` entry in `USER_ROLES` was the obvious shape and is not what was built. It would
ripple through the role model, the 48-rule policy table, 00004's CHECK constraint, the frontend's
role handling and every role-related test — to express something a column already expresses. The role
set is unchanged: five roles, exactly as ADR 0009 defines them.

### The four refusals

`decideRoleChange` does no I/O, so every rule is a named branch testable without an HTTP server.

1. **Not a super admin** — checked *first*, so a refused caller learns nothing about whether the
   target exists. A 403 that varies by target id is an enumeration oracle over the user list.
2. **Not yourself, in either direction.** Demotion: a super admin who mis-clicks their own row has
   removed the only power that could restore it. Promotion: a self-change is the one role change with
   no second person in it, so the audit row would record somebody authorising themselves.
3. **Not a role that does not exist** — reported before "no such user", so a typo names itself.
4. **Not a grant-sourced role.** This is the rule most likely to be mistaken for an oversight.
   00004's trailing `update` re-asserts every grant on each migration run, so an in-app change here
   would appear to work, persist for days, and silently revert on the next deploy — leaving an audit
   trail that says the change happened and a database that disagrees. The refusal names the remedy:
   edit the grant list.

The last rule is enforced **twice** — in `decideRoleChange` and again as a `neq("role_source",
"grant")` predicate on the update itself. Redundant today; it means the dangerous edit needs two
mistakes rather than one.

### Every change is audited

A role change writes `user.role-changed.v1` to `audit_log` (ADR 0011), whose `update` and `delete`
are revoked from `service_role` itself — so it cannot be edited or erased even by the process that
wrote it. `GET /audit/subjects/user/:id` answers *how did this account come to hold what it holds*,
which is the first question an auditor asks about a platform holding a register of vulnerable people.

**Both roles are in the payload.** "X is now a district officer" cannot be reviewed; "X was a citizen
and is now a district officer" can. The previous value is unrecoverable after the write — the log is
append-only and there is no earlier row to join to — so it is captured before the update and carried
through.

No parallel `role_changes` table. A second history would be a second thing to keep in step, and the
weaker of the two would become the one somebody trusts.

## Consequences

**Nobody can be appointed in advance.** A person appears in the list once they have registered.
Pre-authorisation stays with `role_grants`, because pre-authorisation is exactly how somebody becomes
an administrator without anyone meeting them, and that must remain a reviewed diff.

**`GET /admin/users` is super-admin-only even though it is a read.** A directory of every email
beside its role is reconnaissance for anyone who has compromised one account, and an administrator
who cannot appoint has no operational need for it.

**The panel steers towards `district_officer`.** Not a style preference: a district officer already
has every workflow, so an admin appointment should be rare and deliberate. The page says so where the
decision is made, and the confirmation names what an administrator can read.

**A super admin cannot be demoted in-app, including by another super admin.** Their role is asserted
by version control; removing one means editing the grant list. That is slower and it is the right
speed for that particular change.

**The in-memory runtime has an empty user directory.** The development server pins everyone to
`citizen` and has no `user_profiles` table, so there is nobody to appoint. Seeding a fake super admin
would make development disagree with every real deployment about the one thing this is careful about.

**`roleSource` is exposed on `GET /me` and is cosmetic there**, exactly like `permissions`. It
decides whether to render a panel, never whether a request is honoured. It must never be read out of
the access token: a role source decoded from a JWT is a claim its holder wrote about themselves, and
this field decides who may hand out unchecked access.

## What this does not solve

**A compromised super admin is still unbounded.** They can appoint administrators freely, and the
audit trail records it without preventing it. There is no second-person approval, no time delay and
no notification. For a platform with one owner that is proportionate; it stops being proportionate
the moment there are several super admins who do not know each other well.

**There is no de-provisioning workflow.** Demoting somebody to `citizen` is a role change like any
other, and nothing revokes their existing session — they hold their access token until it expires.
ADR 0015's session model makes that at most an hour; it is not immediate, and an urgent removal needs
the Supabase dashboard.

**Nothing limits how many administrators exist.** A super admin can appoint everybody. The
constraint is social, and this ADR is the place it is written down rather than assumed.
