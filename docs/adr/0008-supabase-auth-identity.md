# ADR 0008 — Supabase Auth for identity: email/password and Google, without a browser SDK

**Status:** Proposed

## Context

The API is currently gated by a single shared bearer token (`packages/api/src/auth.ts`),
described in its own source as "a deliberate stopgap for the MVP". That token has no notion of
*who* is acting. It cannot express that a district officer sees more than an NGO field worker,
cannot attribute a change to a person, and cannot be revoked for one user without revoking it for
everyone. Every requirement now on the table — self-registration, an administrator account,
per-user edit rights, audit trails, Google sign-in — is blocked on the platform having real
identities.

Three constraints shape the choice:

1. **Supabase is already the system of record** (ADR 0004). Its Auth service (GoTrue) issues JWTs
   signed by the same project, and Postgres RLS policies can read those claims via `auth.jwt()` —
   the beneficiary policy in `00002_rls_policies.sql` is already written against an `ngo_id` claim
   that nothing currently issues.
2. **The frontend is one self-contained HTML file with zero external references** (ADR 0012's
   ancestor: the dashboard is inlined into `dist/server.js` and the container has no CDN egress).
   A conventional `@supabase/supabase-js` browser integration is therefore not available to us
   without bundling a second frontend artifact and abandoning the single-file property.
3. **Users will be non-technical and often on poor connections** — village committee members and
   NGO field staff on phones. Password reset and email verification must work over email, and the
   sign-in path must be forgiving.

## Decision

**Adopt Supabase Auth (GoTrue) as the sole identity provider.** Retire the shared bearer token.

### Authentication methods, in priority order

| Method | Rationale |
|---|---|
| Google OAuth | Requested first; NGO and government staff overwhelmingly have Google accounts, and it removes password handling for most users |
| Email + password | Required for users without Google, and for the administrator bootstrap |

Additional providers are configuration in the Supabase dashboard plus one entry in a provider
list; the design should not hard-code "Google" anywhere except that list.

### The browser talks to GoTrue's REST API directly — no SDK

`@supabase/supabase-js` will **not** be added to the page. GoTrue is a plain REST API and every
flow we need is a `fetch` or a redirect:

| Flow | Call |
|---|---|
| Register | `POST {SUPABASE_URL}/auth/v1/signup` |
| Sign in | `POST {SUPABASE_URL}/auth/v1/token?grant_type=password` |
| Refresh | `POST {SUPABASE_URL}/auth/v1/token?grant_type=refresh_token` |
| Google | redirect to `{SUPABASE_URL}/auth/v1/authorize?provider=google`, tokens returned in the callback URL fragment |
| Sign out | `POST {SUPABASE_URL}/auth/v1/logout` |

All of these take the **publishable** key, never the service-role key. This preserves the
single-file frontend, adds no build step, and keeps the page's dependency count at zero.

The cost is that we write and maintain the token-refresh loop and the OAuth fragment handling
ourselves — perhaps 150 lines — instead of inheriting battle-tested SDK code. We accept that,
because the alternative sacrifices a property (self-contained artifact, no supply chain in the
browser) that has repeatedly proven valuable in this codebase.

### The API verifies JWTs; it does not issue them

`packages/api/src/auth.ts` is **replaced**, not extended. The new module:

- extracts the `Authorization: Bearer <jwt>` header,
- verifies the signature against the project's JWKS endpoint (asymmetric keys) with a cached key
  set, falling back to the shared JWT secret (HS256) for older projects,
- validates `exp`, `iss` and `aud`,
- resolves the token's `sub` to an application user and its role (ADR 0009),
- rejects with 401 on any failure, distinguishing *expired* from *invalid* in the response so the
  frontend knows whether to refresh or to re-authenticate.

Verification uses a real JOSE implementation (`jose`), not hand-rolled crypto. This is
server-side, so it does not affect the frontend's zero-dependency property.

### Token storage in the browser

Access token in memory; refresh token in `sessionStorage`. Not `localStorage` — a refresh token
that survives tab closure on a shared or public device is a longer-lived credential than this
product needs. Closing the tab ends the session. This is deliberately stricter than the Supabase
default and will mean more frequent sign-ins; for a platform holding beneficiary records that is
the right side of the trade.

### The administrator bootstrap

`mondweep@dxsure.uk` is granted the `admin` role by a migration that is idempotent and keyed on
email, so it applies whether or not that account has signed up yet (ADR 0009 covers the role
model). Bootstrapping through a migration rather than a manual dashboard click means the
administrator exists identically in every environment and the grant is reviewable in version
control.

## Alternatives considered

**Keep the shared token, add a second one per role.** Cheapest, and genuinely tempting for a
pilot. Rejected because it still cannot attribute a change to a person, which makes the audit
requirement (ADR 0011) unsatisfiable — and audit is not decoration here, it is the accountability
the whole product exists to provide.

**Auth0 / Clerk / WorkOS.** Better developer experience and more mature account-recovery flows.
Rejected because it adds a second vendor, a second bill and a second outage surface for a
capability the existing vendor already provides — and because RLS reading `auth.jwt()` only works
naturally when Supabase issued the token.

**Roll our own sessions (passwords in our own table).** Rejected without much deliberation.
Password storage, reset flows, rate limiting and breach response are a specialised problem, and
getting them subtly wrong on a system holding records about widows and orphaned children is not a
risk worth taking to avoid a dependency.

**Bundle `supabase-js` into the page.** Would give us maintained refresh and OAuth handling.
Rejected because it costs the single-file artifact and introduces a browser supply chain; the REST
surface we actually need is small enough to own.

## Consequences

- The `ngo_id` claim that `00002_rls_policies.sql` already expects can finally be issued, so the
  RLS policies stop being aspirational.
- Sessions end when the tab closes. Expect this to be reported as a bug; it is not.
- We own the refresh loop. If it is wrong, users get spurious 401s — so it needs explicit tests
  around expiry boundaries, not just a happy-path login test.
- Google sign-in requires OAuth credentials configured in both Google Cloud and the Supabase
  dashboard, including the redirect URL. That is environment configuration, not code, and must be
  documented in `docs/DEPLOYMENT.md` or the first deploy to a new environment will fail confusingly.
- `API_TOKEN` and its Secret Manager entry are removed once migration completes. Until then both
  paths are accepted, and `/health` must disclose when the legacy path is still enabled — a
  transitional weakness that is invisible is a transitional weakness that becomes permanent.
