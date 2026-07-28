# AFRIP — AI-Powered Flood Recovery & Village Development Intelligence Platform

From emergency relief to long-term village development — one continuous platform.
**One Village → One NGO → One Village Leadership Team.**

## Documentation

| Document | What it covers |
|---|---|
| **[docs/DESIGN.md](docs/DESIGN.md)** | **System design**: context / container / component views, domain flows, eventing, persistence, security model, failure modes, known limitations |
| **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** | **How to deploy**: Supabase provisioning, Google Cloud Run (recommended), Netlify alternative, verification, rollback, troubleshooting |
| [docs/PRD.md](docs/PRD.md) | Product requirements, domain-driven: ubiquitous language, bounded contexts, aggregates and invariants, phased requirements |
| [docs/adr/](docs/adr/) | ADRs 0001–0007: hexagonal architecture, TypeScript monorepo, London-school TDD, Supabase, domain events, agent-swarm build, phased delivery |
| [supabase/](supabase/) | Schema migrations, RLS policies, public transparency views |

## Layout

```
packages/
  shared-kernel/              Result, branded IDs, Money, DomainEvent, ports, test fakes
  village-registry/           Village profile, damage assessments, severity          [core]
  ngo-coordination/           One-active-NGO-per-village, capacity, committees        [core]
  beneficiary-registry/       Vulnerable persons, aid history, duplicate-aid flags    [core]
  fund-monitoring/            Sanctioned/released/spent arithmetic, anomaly rules     [core]
  recovery-intelligence/      11-dimension village health score, recommendations      [core]
  social-media-intelligence/  SignalExtractor ACL port, deterministic smart alerts    [core]
  issue-tracking/             Citizen issues, status machine, routing policy          [supporting]
  volunteer-management/       Registration, assignment, hours, leaderboard            [supporting]
  development-planning/       Long-term goals and milestones per village              [supporting]
  platform/                   Composition root: wires contexts over the event bus
  api/                        HTTP service — the deployable process
```

Each context is hexagonal: `src/domain` (aggregates, value objects, policies), `src/application`
(use cases + ports), `src/adapters` (in-memory fakes and Supabase repositories). Contexts share only
identifiers and event contracts — integration happens through domain events, never direct calls.
Only `packages/api` is a running process; everything else is a library.

## Run it locally

```bash
npm install
npm test          # 814 tests
npm run typecheck # tsc --noEmit, strict
npm run dev       # build + serve on http://localhost:8080, in-memory persistence
```

> **`dev` does not watch.** It bundles once, then serves. A build step is
> mandatory here — Node's type stripping does not rewrite this codebase's `.js`
> import specifiers, and the dashboard is inlined through an esbuild-only
> `.html` text loader — so the API cannot be run straight from TypeScript
> source. The practical consequence: **editing `packages/web/src/index.html` (or
> any source file) changes nothing until you re-run `npm run dev`.** Refreshing
> the browser will keep showing the previously bundled page, with no warning
> that it is stale.

```bash
curl localhost:8080/health          # {"status":"ok","persistence":"memory",...}
curl localhost:8080/public/villages # public transparency projection
```

In-memory mode needs no database or keys — data lives in the process and is lost on restart.
For persistence, set `PERSISTENCE=supabase` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
(see [`.env.example`](.env.example)).

### API surface

`GET /health` and `GET /ready` (health probes), `GET /public/villages` (public, no PII), plus
authenticated routes for villages, NGO assignment and committees, beneficiaries and aid, issues,
and recovery scores. Set `API_TOKEN` to require `Authorization: Bearer <token>` on everything
except the public and probe routes — without it the API starts unauthenticated and says so loudly.
Bearer tokens are a stopgap; Supabase Auth with RLS-scoped JWTs is the production path
(see [docs/DESIGN.md](docs/DESIGN.md) §8).

## Deploy

**Google Cloud Run is the recommended target** — this is a long-lived containerized Node process
with an in-process event bus, which suits a container runtime rather than a function runtime.
Netlify is documented as the alternative and becomes the better choice once a static dashboard
frontend exists.

```bash
gcloud auth login mondweep@dxsure.uk
gcloud config set project e-vidhayak
./scripts/deploy-cloudrun.sh
```

Full instructions — including Supabase provisioning, applying migrations, Secret Manager wiring,
verification, rollback and troubleshooting — are in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## How this was built

Phase-wise, by a Ruflo agent swarm with models matched to task complexity (ADR 0006): one
London-school TDD agent per bounded context in parallel, then an adversarial review wave whose ten
confirmed findings were each fixed test-first, then a second wave for the API, persistence adapters
and deployment tooling.
