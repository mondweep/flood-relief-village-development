# AFRIP — AI-Powered Flood Recovery & Village Development Intelligence Platform

Built in response to the unprecedented, atypical floods that struck **Upper Assam in July 2026**.
From emergency relief to long-term village development — one continuous platform.
**One Village → One NGO → One Village Leadership Team.**

**Live:** https://flood-recovery-village-development-mon-58061828953.europe-west2.run.app

Concept by [Dilip Bharatee](https://www.linkedin.com/in/dilip-bharatee-951232).
Built and maintained by [Mondweep Chakravorty](https://www.linkedin.com/in/mondweepchakravorty/).

> **Every village currently on the platform is demonstration data**, labelled `Demo` wherever it
> appears and excluded from every published total. Nothing about it describes a real household.

## Documentation

| Document | What it covers |
|---|---|
| **[docs/DESIGN.md](docs/DESIGN.md)** | **System design**: context / container / component views, domain flows, eventing, persistence, security model, failure modes, known limitations |
| **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** | **How to deploy**: Supabase provisioning, Cloud Run, verification, rollback, troubleshooting |
| [docs/PRD.md](docs/PRD.md) | Product requirements, domain-driven: ubiquitous language, bounded contexts, aggregates and invariants, phased requirements |
| [docs/adr/](docs/adr/) | **ADRs 0001–0016** — every architectural decision, including the ones that turned out to be wrong and were amended |
| [docs/incidents/](docs/incidents/) | Post-mortems. Currently one: an id collision that destroyed a village record and misattributed its children |
| [supabase/](supabase/) | Schema migrations 00001–00009, RLS policies, public transparency views |

## Layout

```
packages/
  shared-kernel/              Result, branded IDs, Money, DomainEvent, authorization vocabulary, ports
  village-registry/           Village profile, damage, severity, coordinate provenance     [core]
  ngo-coordination/           One-active-NGO-per-village, capacity, committees             [core]
  beneficiary-registry/       Vulnerable persons, aid history, duplicate-aid flags         [core]
  fund-monitoring/            Sanctioned/released/spent arithmetic, anomaly rules          [core]
  recovery-intelligence/      11-dimension village health score, recommendations           [core]
  social-media-intelligence/  SignalExtractor ACL port, deterministic smart alerts         [core]
  issue-tracking/             Citizen issues, status machine, routing policy               [supporting]
  volunteer-management/       Registration, assignment, hours, leaderboard                 [supporting]
  development-planning/       Long-term goals and milestones per village                   [supporting]
  platform/                   Composition root + the ADR 0009 authorization policy table
  api/                        HTTP service — the deployable process
  web/                        The single-file dashboard, inlined into the API bundle
```

Each context is hexagonal: `src/domain` (aggregates, value objects, policies), `src/application`
(use cases + ports), `src/adapters` (in-memory fakes and Supabase repositories). Contexts share only
identifiers and event contracts — integration happens through domain events, never direct calls.
Only `packages/api` is a running process; everything else is a library.

## Run it locally

```bash
npm install
npm test          # the regression pack — 1,388 tests across 115 files at time of writing
npm run typecheck # tsc --noEmit, strict
npm run build     # esbuild bundle; NOT exercised by npm test — see below
npm run dev       # build + serve on http://localhost:8080, in-memory persistence
```

> **`dev` does not watch.** It bundles once, then serves. A build step is mandatory — Node's type
> stripping does not rewrite this codebase's `.js` import specifiers, and the dashboard is inlined
> through an esbuild-only `.html` text loader — so the API cannot run straight from TypeScript
> source. **Editing `packages/web/src/index.html` changes nothing until you re-run `npm run dev`.**
> The browser will keep serving the previously bundled page with no warning that it is stale.

```bash
curl localhost:8080/health          # {"status":"ok","persistence":"memory",...}
curl localhost:8080/public/villages # public transparency projection
```

In-memory mode needs no database or keys — data lives in the process and is lost on restart.
For persistence set `PERSISTENCE=supabase` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
(see [`.env.example`](.env.example)).

## Testing and the regression pack

The suite **is** the regression pack. It is not a separate artefact and there is nothing extra to
run.

| Layer | What it covers |
|---|---|
| Domain | Aggregates and invariants, per bounded context, London-school with `vi.fn()` port doubles |
| Application | Use cases against mocked ports — the collaboration, not the state |
| Adapters | Supabase repositories driven through a fake client; no network |
| API | The real HTTP server on an ephemeral port, real routing, real auth gate |
| Cross-cutting | Authorization over HTTP per role, audit attribution, ownership, tile-proxy bounds |
| Frontend | The page parsed as text: permission keys, theme contrast, undefined CSS classes |

Two properties worth knowing, because they are unusual and deliberate:

**Findings are mutation-checked.** A test that would pass with the production code broken is worse
than no test, because it manufactures confidence. Significant guards in this repository were
verified by deliberately breaking the code and confirming the named test fails. Several times that
exercise found the *test* to be wrong rather than the code — those are recorded in the commit
messages.

**The frontend is checked statically, because it cannot be checked any other way.** The page is an
opaque string to the bundler, so the two sides only meet over HTTP. A live 400 on village
registration once passed 1,300 green tests. The frontend tests assert the things that fail silently:
permission keys that exist server-side, CSS classes that are actually defined, and colour variables
used for what they mean rather than what they are named.

## Deploy pipeline and gates

```bash
gcloud auth login mondweep@dxsure.uk
./scripts/deploy-cloudrun.sh
```

**The deploy is gated.** `scripts/deploy-cloudrun.sh` runs the regression pack before anything is
built or shipped, in this order:

```
typecheck  →  npm test  →  npm run build  →  gcloud preflight  →  Cloud Build  →  Cloud Run
```

Cheapest first, so the fastest signal fails soonest. The gate runs **before** the gcloud preflight —
a failing suite should cost nothing and reach no conclusion about your credentials — and **before**
Cloud Build, so a broken commit never spends a build minute. A failure prints
`[fatal] … Nothing was deployed` and exits non-zero.

`npm run build` is inside the gate because **`npm test` does not exercise esbuild**. A missing loader
or unresolved import is invisible to vitest and fatal at deploy; that break has happened here.

`SKIP_TESTS=1` bypasses the gate, for re-deploying a revision whose suite already passed when only
deploy configuration changed. It warns loudly — a silent skip is how a gate stops being one.

### CI

[`.github/workflows/regression.yml`](.github/workflows/regression.yml) runs the same pack on every
push and pull request, on a clean machine from a lockfile install, then boots the bundle and asks it
for `/health`.

CI does **not** replace the local gate. A green tick on a commit says nothing about the working tree
`--source` is about to upload — the deploy uploads what is on disk, not what is committed. Both
exist; they catch different things.

### Which revision is live

Every deploy stamps the git branch and commit into `GET /health`, and the page footer renders it:

```bash
curl -s <url>/health | jq .build
# { "branch": "main", "commit": "40d5b23", "repository": "https://github.com/..." }
```

An uncommitted working tree deploys as `<sha>-dirty`. This exists because deploys were repeatedly
made from a feature branch while `main` sat behind, and nothing said so.

## Environments

| Environment | Status |
|---|---|
| **Local** | In-memory, no credentials. `npm run dev` |
| **Production** | Cloud Run `europe-west2`, Supabase `eu-west-1`. The live URL above |
| **Staging** | **Does not exist.** See below |

**There is no staging environment.** Changes go from a developer's machine to production, gated by
the regression pack and nothing else. That is stated plainly because the alternative — a README
implying a validation step that is not there — is worse than the gap itself.

Building one is cheap and has been assessed rather than guessed:

- **The application half is nearly free.** `SUPABASE_SCHEMA` is already parameterised, so a staging
  service is a second Cloud Run deployment pointed at `assam_floods_staging` with the migrations
  applied there. Roughly an hour.
- **Authentication would be shared.** Supabase Auth (GoTrue) is per *project*, so staging and
  production would share one user pool. Only `user_profiles` is schema-scoped, so a person could
  hold different roles in each. Workable, and worth knowing before it surprises somebody.
- **The highest-value slice is migrations, not the whole environment.** Migrations are the one thing
  with no undo — the [id-collision incident](docs/incidents/) was unrecoverable. Applying each
  migration to a staging schema first, before production, gets most of the protection for a fraction
  of the work.

## Security and identity

| | |
|---|---|
| Identity | Supabase Auth (GoTrue). Email/password and Google. JWTs verified locally against JWKS; the API never issues a token (ADR 0008) |
| Membership | **Explicit.** A valid token is not membership — the Supabase project is shared with unrelated applications, so a profile is created only by deliberate registration (ADR 0014) |
| Authorization | Five roles, enforced at the use-case boundary. A citizen cannot reach the beneficiary register (ADR 0009) |
| Ownership | You may edit what you created. Recorded off the creation event, so a use case cannot save a record without registering who made it (ADR 0009) |
| Audit | Every domain event persisted with its actor, append-only — `update`/`delete` revoked from `service_role` itself (ADR 0011) |
| Sessions | Access token in memory, refresh token in `sessionStorage`; closing the tab ends the session. 30-minute idle sign-out (ADR 0015) |

The shared static `API_TOKEN` is **retired**. It identified nobody and bypassed every role check.

### Where the data lives

Records are held in a Supabase PostgreSQL database in **AWS eu-west-1 (Ireland)**; the application
runs on Cloud Run in **europe-west2 (London)**. Personal data therefore rests in the EU and the UK,
not in India. That is a consequence of which Supabase project was available rather than a
deliberate choice, and it is worth revisiting against India's DPDP Act.

## API surface

**Public, no credential:** `GET /health`, `GET /ready`, `GET /public/*`, `GET /`, and
`GET /map/tiles/{z}/{x}/{y}` (bounded to Assam — an `<img>` cannot carry a bearer token, so the
proxy is bounded geographically instead).

**Signed in:** villages and amendments, NGO assignment and committees, beneficiaries and aid, issues,
recovery scores, funds, volunteers, plans, signals, geocoding, and `POST /feedback`.

**Admin or district officer:** `GET /audit`, `GET /audit/subjects/:type/:id`, `GET /audit/actors/:id`.

**Admin only:** `POST /villages/:id/demonstration`, and reading the feedback queue.

Amounts are **rupees** (major units) throughout the API — `sanctionedInr`, `amountInr` — with the
symbol added by the client and `currency` carried as a separate field. Storage remains integer paise,
because float money drifts and this platform enforces `spent ≤ released ≤ sanctioned`.

## Reporting a bug or asking for a feature

Signed-in users can report from inside the app (ADR 0016). Reports carry the exact revision and view
automatically, so "it worked yesterday" is checkable rather than a discussion.

**Do not put names or personal details in a report** — reference a village or record by its
identifier. Feedback is free text and is readable by administrators only, precisely because it will
sometimes contain what the beneficiary registry contains.

## How this was built

Phase-wise, by a Ruflo agent swarm with models matched to task complexity (ADR 0006): one
London-school TDD agent per bounded context in parallel, then adversarial review waves whose
confirmed findings were each fixed test-first.

The [ADRs](docs/adr/) record the decisions, **including the ones that were wrong**. ADR 0014 amends
ADR 0008 after contact with a shared Supabase project; ADR 0009 carries a section on where the
implementation falls short of what the ADR promises. A decision record that only contains good
decisions is a marketing document.
