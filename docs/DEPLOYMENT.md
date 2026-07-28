# Deploying AFRIP

How to get the AFRIP API from this repository into production, and how to operate
it once it is there.

---

## Recommendation

**Deploy to Google Cloud Run.** Netlify is documented below as the alternative,
but it is the second choice today.

The API is a containerized, long-lived Node process that wires ten bounded
contexts together over an in-process event bus at startup — that is exactly the
shape Cloud Run runs natively and exactly the shape serverless functions fight.
Cloud Run still scales to zero, so the cost profile that makes functions
attractive is available anyway, without the 10-second execution ceiling that
would cap any bulk import, recovery-index recalculation or anomaly sweep. Talking
to Supabase Postgres over the network from a container is the ordinary case, and
a warm container reuses its connections instead of re-establishing them per
invocation. Netlify becomes the right call later, for a *static dashboard
frontend* served alongside this API — not as the API's own host.

> ### Read this before you deploy: Supabase persistence is wired and preferred
>
> `createSupabaseRuntime()` in `packages/api/src/persistence.ts` is fully
> implemented. `PERSISTENCE=supabase` is the **default and preferred** mode in
> `scripts/deploy-cloudrun.sh` — the server boots against Supabase Postgres,
> `/health` reports `"persistence":"supabase"`, and `/ready` returns 503 with an
> honest error if the database is unreachable (200 once it is).
>
> **`PERSISTENCE=memory` still exists**, but only for smoke tests: it is a
> fully functional API with in-memory state that is lost on every restart (and
> every scale-to-zero on Cloud Run) and not shared between instances. Never
> point real beneficiary or NGO data at it.
>
> The happy path is: provision Supabase (section 2) → apply all three
> migrations, in order → deploy to Cloud Run with `PERSISTENCE=supabase`
> (section 4).

---

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| Node.js 22 | `npm run build` targets `node22`; the container is `node:22-slim` | `node --version` |
| Google Cloud SDK | Builds and deploys Cloud Run | `gcloud version` |
| A GCP project with billing | Cloud Build and Artifact Registry both require it | `gcloud billing projects describe e-vidhayak` |
| A Supabase project | The production data store (ADR 0004) | dashboard |
| Supabase CLI *(optional)* | Applies `supabase/migrations/` from the terminal | `supabase --version` |
| Netlify CLI *(alternative path only)* | `npm i -g netlify-cli` | `netlify --version` |

Install gcloud:

```bash
# macOS
brew install --cask google-cloud-sdk
# Debian/Ubuntu
sudo apt-get install -y google-cloud-cli
# anything else: https://cloud.google.com/sdk/docs/install
```

Confirm the repo builds locally before deploying anything:

```bash
npm ci
npm test          # vitest, in-memory adapters, no credentials needed
npm run typecheck
npm run build     # -> dist/server.js (~91 KB, single self-contained file)
PERSISTENCE=memory node dist/server.js &
curl -fsS localhost:8080/health && kill %1
```

Expected: `{"status":"ok","persistence":"memory","version":"0.1.0","auth":"disabled"}`.

---

## 2. Step 1 — Provision Supabase

### Create the project

In the [Supabase dashboard](https://supabase.com/dashboard), create a project
(e.g. `afrip-platform`). Pick a region close to your users and to `europe-west2`
if you want low API↔DB latency. **Save the database password** — it is shown
once. Creating a project on a paid plan incurs cost; confirm before proceeding.

### Apply the migrations, in order

`supabase/migrations/` holds the deployable schema. Order matters:
`00001_initial_schema.sql` creates the `assam_floods` schema and every context's
tables inside it, `00002_rls_policies.sql` turns on RLS, issues the schema
grants and creates the public transparency views, and
`00003_lifecycle_timestamps.sql` adds the lifecycle timestamp columns the API
relies on. Apply all three, in order.

> **AFRIP tables live in the `assam_floods` schema, not `public`.**
>
> This matters most when the Supabase project is shared with other
> applications — the reference project's `public` schema already holds
> unrelated tables (`kg_nodes`, `chat_messages`, `swarm_vitals`, …) and the
> other applications each occupy a schema of their own (`agentic_ai_news`,
> `brigade_sales`, `driftwise`, `ruflo_demo`). Putting AFRIP in `public` would
> risk name collisions with a neighbouring app and make "which tables are
> ours?" unanswerable.
>
> The migrations schema-qualify every object and touch nothing outside
> `assam_floods`, so they are safe to run against a project that already has
> other tenants in it. They are also re-runnable: every statement is
> `if not exists`, `create or replace`, or a drop-then-create.
>
> Note the naming: the schema is `assam_floods` with an **underscore**. An
> unquoted Postgres identifier cannot contain a hyphen, so `assam-floods` would
> force every table reference everywhere to be double-quoted forever.

### Expose the schema to the API (required)

PostgREST — the layer behind the Supabase client — only serves schemas that are
explicitly exposed. A brand-new custom schema is **not** exposed by default, so
skipping this step leaves every request failing even though the tables exist.

Dashboard → **Project Settings** → **Data API** → **Exposed schemas**: add
`assam_floods` alongside whatever is already listed, and save. (Leave the other
entries alone — removing `public` would break the project's other applications.)

The change takes a few seconds to propagate. `GET /ready` on the deployed
service is the check: it runs a bounded select against
`assam_floods.village_registry_villages`, so it fails while the schema is
unexposed and passes once it is.

**Path A — Supabase CLI (preferred; it records what has been applied):**

```bash
supabase login
# The project ref is the subdomain of your project URL:
# https://<project-ref>.supabase.co  -> you supply this value
supabase link --project-ref <your-project-ref>
supabase db push
```

Verify:

```bash
supabase migration list          # all three migrations shown as applied remotely
```

**Path B — dashboard SQL editor (no CLI required):**

1. Dashboard → **SQL Editor** → **New query**.
2. Paste the entire contents of `supabase/migrations/00001_initial_schema.sql`, run it.
3. Open a new query, paste `supabase/migrations/00002_rls_policies.sql`, run it.
4. Open a new query, paste `supabase/migrations/00003_lifecycle_timestamps.sql`, run it.
5. Do not reorder or merge them — `00002` alters tables that `00001` creates, and
   `00003` alters tables both of the earlier migrations touch.

Verify either path in **Table Editor**: switch the schema selector from `public`
to **`assam_floods`** — the tables are not in `public` and the editor opens on
`public` by default, so an empty-looking list usually means the selector, not a
failed migration. You should then see the context-prefixed tables
(`village_registry_villages`, `ngo_coordination_assignments`,
`fund_monitoring_projects`, …), each with the RLS shield icon, plus the views
`public_village_recovery` and `public_fund_transparency`. Those two view names
describe their *audience* — they are anon-readable — and they live in
`assam_floods` with everything else.

### Collect the credentials

Dashboard → **Project Settings**:

| Value | Where | Secret? |
|---|---|---|
| `SUPABASE_URL` | Data API → Project URL (`https://<ref>.supabase.co`) | No |
| `SUPABASE_SERVICE_ROLE_KEY` | API keys → `service_role` | **Yes** |
| anon / publishable key | API keys → `anon` | No — for a future frontend |

> **The service-role key bypasses Row Level Security completely.** Every policy
> in `00002_rls_policies.sql` is inert in its presence; it is a full-database
> credential with no per-user scoping. It must exist **only** server-side — in
> Google Secret Manager, in Netlify's secret env store, or in a git-ignored local
> `.env`. Never in a browser bundle, never in a client app, never in a commit,
> never in a screenshot. If it is exposed, rotate it in the dashboard
> immediately. A frontend uses the **anon** key and goes through RLS.

---

## 3. Step 2 — Configure environment

`.env.example` is the full, commented list of what the service reads. For local
development:

```bash
cp .env.example .env
# then fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_TOKEN
```

`.env` is git-ignored. Do not remove it from `.gitignore`.

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | Defaults to 8080. **Never set it on Cloud Run** — the platform injects it. |
| `NODE_ENV` | no | `production` in every deployed environment |
| `PERSISTENCE` | no | `supabase` (default, recommended) \| `memory` (smoke tests only) |
| `SUPABASE_URL` | when `supabase` | Not a secret |
| `SUPABASE_SERVICE_ROLE_KEY` | when `supabase` | **Secret** → Secret Manager |
| `SUPABASE_SCHEMA` | no | Postgres schema holding the AFRIP tables. Defaults to `assam_floods`. Leave unset. |
| `API_TOKEN` | yes in prod | **Secret** → Secret Manager. Unset ⇒ auth disabled. |

Configuration is validated at startup and fails fast: an out-of-range `PORT`, an
unrecognised `PERSISTENCE`, or `PERSISTENCE=supabase` without both Supabase
variables all cause a non-zero exit with a specific message, rather than a
half-configured server.

### `SUPABASE_SCHEMA`

The Supabase adapters do not use the client's default schema — that default is
`public`, which in a shared project belongs to other applications. Every query
names its schema explicitly, resolved in this order:

1. `SUPABASE_SCHEMA`, if set to a non-blank value;
2. otherwise `assam_floods`, the built-in default.

There is no third case: a blank or whitespace-only value is treated as unset and
falls back to `assam_floods`, never to `public`. The readiness probe behind
`GET /ready` queries the same schema the adapters write to, so a mismatch
between this variable and what the migrations created surfaces as a failing
readiness check rather than as silent writes to the wrong place.

**Normal deployments should leave `SUPABASE_SCHEMA` unset.** It exists for the
case where a second environment shares one Supabase project — a review or
staging stack pointed at, say, `assam_floods_review`, populated by running the
same migrations with the schema name substituted.

> Setting `SUPABASE_SCHEMA=public` is accepted by the config layer but is
> exactly the mistake the default exists to prevent: on the shared project it
> aims AFRIP at other applications' tables.

Generate the API token:

```bash
openssl rand -hex 32
```

---

## 4. Step 3 — Deploy to Cloud Run

### Authenticate and target the project

```bash
gcloud auth login mondweep@dxsure.uk
gcloud config set project e-vidhayak
gcloud config set run/region europe-west2
```

### Scripted (recommended)

`scripts/deploy-cloudrun.sh` does preflight checks, enables APIs, reconciles
Secret Manager, grants the runtime service account access, builds, deploys and
smoke-tests. Supply the secrets **once** — afterwards they live in Secret
Manager and the script reuses them.

`PERSISTENCE=supabase` is the default, so a plain invocation deploys the
persistent, recommended configuration. Supply `SUPABASE_URL` and seed the
service-role key the first time:

```bash
cd /home/user/flood-relief-village-development

SUPABASE_URL=https://<your-project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY='<your service_role key>' \
API_TOKEN="$(openssl rand -hex 32)" \
  ./scripts/deploy-cloudrun.sh
```

Every subsequent deploy just needs `SUPABASE_URL` (the script remembers the
secrets already in Secret Manager):

```bash
SUPABASE_URL=https://<your-project-ref>.supabase.co ./scripts/deploy-cloudrun.sh
```

Defaults: `PROJECT_ID=e-vidhayak`, `REGION=europe-west2`, `SERVICE=afrip-api`,
`PERSISTENCE=supabase`. Override any of them, plus `MIN_INSTANCES`,
`MAX_INSTANCES`, `MEMORY`, `CPU`, `CONCURRENCY`, `TIMEOUT`, `SERVICE_ACCOUNT`,
through the environment.

The script checks credentials strictly: `PERSISTENCE=supabase` without
`SUPABASE_URL`, or without the `afrip-supabase-service-role-key` secret already
in Secret Manager (or supplied via `SUPABASE_SERVICE_ROLE_KEY` on this
invocation), fails fast with a specific message before any Cloud Build spend.

For a smoke test only, with no durable state, opt into memory mode explicitly —
the script prints a loud warning that all data is lost on every scale-to-zero:

```bash
PERSISTENCE=memory API_TOKEN="$(openssl rand -hex 32)" ./scripts/deploy-cloudrun.sh
```

### Manual equivalent

If you would rather not run the script, this is what it does.

```bash
# 1. Enable the APIs (idempotent)
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project e-vidhayak

# 2. Create the secrets. Note printf (no trailing newline) — a stray \n in a
#    JWT or bearer token is a classic cause of "works locally, 401 in prod".
printf '%s' '<your service_role key>' | gcloud secrets create afrip-supabase-service-role-key \
  --project e-vidhayak --replication-policy=automatic --data-file=-

printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create afrip-api-token \
  --project e-vidhayak --replication-policy=automatic --data-file=-

# 3. Let the Cloud Run runtime service account read them
PROJECT_NUMBER="$(gcloud projects describe e-vidhayak --format='value(projectNumber)')"
for S in afrip-supabase-service-role-key afrip-api-token; do
  gcloud secrets add-iam-policy-binding "$S" --project e-vidhayak \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor" --condition=None
done

# 4. Build from source (uses the repo Dockerfile) and deploy
gcloud run deploy afrip-api \
  --source . \
  --project e-vidhayak \
  --region europe-west2 \
  --platform managed \
  --port 8080 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 10 \
  --memory 512Mi \
  --cpu 1 \
  --concurrency 80 \
  --timeout 300 \
  --set-env-vars NODE_ENV=production,PERSISTENCE=supabase,SUPABASE_URL=https://<your-project-ref>.supabase.co \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=afrip-supabase-service-role-key:latest,API_TOKEN=afrip-api-token:latest

# ... or, for a smoke test only, with no durable state:
#   --set-env-vars NODE_ENV=production,PERSISTENCE=memory \
#   --set-secrets API_TOKEN=afrip-api-token:latest

# 5. Get the URL
gcloud run services describe afrip-api --project e-vidhayak --region europe-west2 \
  --format='value(status.url)'
```

To rotate a secret later, add a new version — the `:latest` reference picks it
up on the next revision:

```bash
printf '%s' '<new value>' | gcloud secrets versions add afrip-api-token \
  --project e-vidhayak --data-file=-
gcloud run services update afrip-api --project e-vidhayak --region europe-west2 \
  --update-secrets API_TOKEN=afrip-api-token:latest
```

### Sizing decisions

**Region.** `europe-west2` (London) is the default. The one thing that actually
matters is that Cloud Run and Supabase sit close together — every request makes
several round trips to Postgres, so a mismatched pair adds latency to *every*
call. If your Supabase project is in `ap-south-1` (Mumbai), deploy to
`asia-south1` instead: `REGION=asia-south1 ./scripts/deploy-cloudrun.sh`.

**`--min-instances` — a genuine tradeoff, not a default to accept blindly.**

| | `0` (default here) | `1` |
|---|---|---|
| Idle cost | none | one instance billed 24/7 |
| First request after idle | cold start: container pull + Node boot + composition root | served immediately |
| Good for | pilots, internal use, bursty NGO reporting | public dashboards, demos, anything user-facing |

Cold starts here are not catastrophic — the image is small and the bundle is a
single file — but they are real, and they compound with Supabase connection
setup. Start at `0`. Move to `1` the moment a human is waiting on the first
request of the morning: `MIN_INSTANCES=1 ./scripts/deploy-cloudrun.sh`.

**`--max-instances 10`** is a blast-radius limit as much as a scaling one. Each
instance opens its own Supabase connections; unbounded scaling under a traffic
spike will exhaust the database's connection limit before it exhausts your
budget. Raise it only alongside Supabase's connection pooler.

**`--memory 512Mi --cpu 1`** is comfortable for a bundle of this size. Watch the
memory metric before trimming to 256Mi; Node's heap plus the bundle leaves less
headroom than it looks.

**`--concurrency 80`** — the Cloud Run default, and correct for an I/O-bound API
that spends most of each request waiting on Postgres. Lower it (to ~20) only if
you add CPU-heavy work such as large recovery-index recalculations.

**`--timeout 300`** is the request ceiling. It exists; it is not a target.

---

## 5. Step 4 — Verify

```bash
URL="$(gcloud run services describe afrip-api --project e-vidhayak \
        --region europe-west2 --format='value(status.url)')"

curl -fsS "$URL/health"
curl -fsS "$URL/ready"
curl -fsS "$URL/public/villages"
```

What healthy looks like — these are the actual responses from the built bundle,
not illustrations:

**`GET /health`** — 200, immediately, no auth. Liveness only: the process is up
and serving. It answers even when the datastore is not.

```json
{"status":"ok","persistence":"supabase","version":"0.1.0","auth":"bearer"}
```

`"auth"` is the field to check first after a deploy: `"bearer"` means the token
gate is on, `"disabled"` means `API_TOKEN` never reached the container and every
non-public route is open.

**`GET /ready`** — readiness includes dependencies. In `PERSISTENCE=supabase`
mode this means the database was actually reached:

```json
{"status":"ready","persistence":"supabase"}
```

In `memory` mode there is no external dependency, so it is necessarily always
ready:

```json
{"status":"ready","persistence":"memory"}
```

#### Reading a 503 from `/ready`

| Response | Meaning |
|---|---|
| `/health` 200, `/ready` 200 | Process is up, database reachable. Healthy. |
| `/health` 200, `/ready` 503 | Process is up, but Supabase could not be reached. The API is running; the database is not. |

A 503 on `/ready` with a 200 on `/health` means the container started fine but
the Supabase connection failed. Check, in order:

1. **`SUPABASE_URL`** — correct project, `https://` scheme, no trailing slash,
   and the project is not paused (free-tier projects pause after inactivity —
   resume it in the dashboard).
2. **`SUPABASE_SERVICE_ROLE_KEY`** — the secret mounted into the container.
   Confirm with `gcloud run services describe afrip-api --project e-vidhayak
   --region europe-west2 --format='yaml(spec.template.spec.containers[0].env)'`
   and check `roles/secretmanager.secretAccessor` was granted (step 3/4 above).
3. **Migrations ran** — all three files in `supabase/migrations/` applied, in
   order. `supabase migration list` shows the remote state. Remember the tables
   are in `assam_floods`; an empty `public` schema is expected, not a symptom.
4. **`assam_floods` is exposed to the Data API** — Project Settings → Data API →
   Exposed schemas. This is the most common 503 on a *first* deployment against
   a new project: the migrations succeeded, the credentials are right, and
   PostgREST still refuses to serve a schema it has not been told about. The
   error text mentions the schema rather than a missing relation.
5. **`SUPABASE_SCHEMA`** — if it is set, it must match the schema the migrations
   actually created. Unset is correct for a normal deployment.

The 503 body includes the specific error, so start there before working through
the checklist.

**`GET /public/villages`** — 200, no auth. An object with a `villages` array (not
a bare array). Empty is correct on a fresh deployment, not a failure:

```json
{"villages":[]}
```

Authenticated call, once `API_TOKEN` is set:

```bash
TOKEN="$(gcloud secrets versions access latest --secret=afrip-api-token --project e-vidhayak)"
curl -fsS -H "Authorization: Bearer $TOKEN" "$URL/villages"      # 200
curl -s -o /dev/null -w '%{http_code}\n' "$URL/villages"          # 401
```

The 401 is the important one. If an unauthenticated request to `/villages`
returns 200, the token gate is off — see Troubleshooting.

---

## 6. Alternative — Netlify

Use this only with eyes open. `netlify/functions/api.mts` documents the seams in
detail; the summary:

- **Netlify Functions are AWS Lambda.** No long-lived process. The API is booted
  inside a container that Netlify recycles at will.
- **The in-process event bus does not survive between invocations.**
  `createPlatform()` wires the bounded contexts over an `InMemoryEventBus`. Each
  Lambda container gets its own. An event published while handling one request
  is delivered only within that container and is gone when it dies. Any handler
  whose effect is not written through to Supabase before the response returns is
  **silently lost**.
- Consequently **`PERSISTENCE=memory` is not merely non-durable here, it is
  incoherent** — concurrent invocations see different worlds. Use
  `PERSISTENCE=supabase` on Netlify for anything beyond a quick demo; it is
  wired and works the same way it does on Cloud Run.
- **10-second synchronous execution limit** (26s on some plans) versus Cloud
  Run's 300s. Long operations must become background functions.
- **Cold starts** pay to boot the entire composition root, not just the HTTP
  layer.
- The adapter boots the server by calling the bundle's exported `main()` and
  proxies over a loopback port. It does **not** merely import the module:
  `server.ts` guards its bootstrap with
  `import.meta.url === pathToFileURL(process.argv[1]).href`, which is false
  under Lambda, so a bare import would never bind a port.

### Steps

```bash
npm i -g netlify-cli
netlify login
netlify init                     # link or create the site

netlify env:set PERSISTENCE supabase
netlify env:set SUPABASE_URL https://<your-project-ref>.supabase.co
netlify env:set SUPABASE_SERVICE_ROLE_KEY '<your service_role key>' --secret
netlify env:set API_TOKEN "$(openssl rand -hex 32)" --secret

# For a smoke test only, with no durable state, use PERSISTENCE=memory instead
# of the three Supabase lines above — see the incoherence warning further up.

netlify build                    # runs npm run build -> dist/server.js
netlify deploy --build           # draft URL
netlify deploy --build --prod    # production
```

Verify the same way:

```bash
curl -fsS https://<your-site>.netlify.app/health
curl -fsS https://<your-site>.netlify.app/ready
```

Local emulation: `netlify dev`. Logs: `netlify logs:function api`, or the
Functions tab in the Netlify UI.

`netlify.toml` currently routes `/*` to the function, which is right only while
there is no frontend. When a dashboard exists, narrow it to `/api/*` plus
`/health` and `/ready`, and let the static site own everything else — that is
the configuration in which Netlify is genuinely the better host.

---

## 7. Post-deploy operations

### Custom domain

Cloud Run's built-in domain mappings are region-limited and still preview in
places, so check availability first:

```bash
gcloud beta run domain-mappings create \
  --service afrip-api --domain api.<your-domain> \
  --region europe-west2 --project e-vidhayak
```

If `europe-west2` does not support mappings, the durable answer is a global
external Application Load Balancer with a serverless NEG pointing at the
service. It also gives you Cloud Armor, a managed TLS certificate and a stable
anycast IP. Either way, add the DNS records the command prints and allow time
for certificate provisioning.

### Logs

```bash
# Live tail
gcloud run services logs tail afrip-api --project e-vidhayak --region europe-west2

# Recent history
gcloud run services logs read afrip-api --project e-vidhayak --region europe-west2 --limit 200

# Errors only, across revisions
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name=afrip-api AND severity>=ERROR' \
  --project e-vidhayak --limit 50 --format=json
```

### Metrics

Console → Cloud Run → `afrip-api` → **Metrics**: request count, p50/p95/p99
latency, instance count, container CPU and memory, and the container startup
latency that tells you what a cold start actually costs you. Set alerting
policies in Cloud Monitoring on 5xx rate and p95 latency before you need them.

### Rollback

Cloud Run keeps every revision, so rollback is a traffic shift — no rebuild.

```bash
# What is available
gcloud run revisions list --service afrip-api --project e-vidhayak --region europe-west2

# Send 100% of traffic to a known-good revision
gcloud run services update-traffic afrip-api \
  --to-revisions afrip-api-00003-abc=100 \
  --project e-vidhayak --region europe-west2

# Back to the newest revision
gcloud run services update-traffic afrip-api --to-latest \
  --project e-vidhayak --region europe-west2
```

Canary a risky change instead of cutting over:

```bash
gcloud run deploy afrip-api --source . --no-traffic --tag next \
  --project e-vidhayak --region europe-west2
gcloud run services update-traffic afrip-api --to-tags next=10 \
  --project e-vidhayak --region europe-west2
```

Note that a rollback shifts **code**, not schema. A migration that dropped a
column is not undone by it — write migrations to be backwards-compatible with
the previous revision.

### Cost at low traffic

Estimates, not quotes — check the
[pricing calculator](https://cloud.google.com/products/calculator) for your
region and current rates.

| Component | With `--min-instances=0` | With `--min-instances=1` |
|---|---|---|
| Cloud Run compute | ~$0 — a pilot's traffic sits inside the monthly free tier | one always-on instance, order of $10–20/month at 1 vCPU / 512Mi |
| Cloud Build | ~$0 — the daily free build-minute allowance covers normal deploy cadence | same |
| Artifact Registry | cents — a few hundred MB of images | same |
| Supabase | $0 on Free (note: free projects pause after ~a week of inactivity), $25/month on Pro | same |

The honest headline: **a low-traffic pilot on `--min-instances=0` is close to
free, and the single biggest lever on the bill is that flag.** Prune old images
periodically (`gcloud artifacts docker images list`) so registry storage does
not creep.

---

## 8. Security checklist

Before anything real touches this deployment:

- [ ] **`API_TOKEN` is set** and the service was redeployed after setting it.
      `curl $URL/health` must report `"auth":"bearer"`, and an unauthenticated
      `/villages` must return 401. The server also logs a loud startup warning
      when the token is absent — check the logs for it.
- [ ] **You know which persistence mode is live.** Check `curl $URL/health` for
      `"persistence":"supabase"`. `memory` means the data is ephemeral and
      per-instance — do not onboard real beneficiary data onto a `memory`
      deployment; there is nothing to lose it *from*.
- [ ] **Secrets are in Secret Manager**, referenced via `--set-secrets`. Run
      `gcloud run services describe afrip-api --project e-vidhayak --region europe-west2 --format=yaml`
      and confirm no key material appears under `env`. Anything in
      `--set-env-vars` is readable by every principal with `run.services.get`
      and is echoed into the console and deploy logs.
- [ ] **RLS is enabled on every table** — `00002_rls_policies.sql` was applied,
      and the Table Editor shows the RLS shield on all of them.
- [ ] **The service-role key has never been client-side.** Not in a frontend
      bundle, not in a mobile app, not in a commit, not in a support ticket.
      Frontends use the anon key and go through RLS.
- [ ] **No `.env` is committed.** `git ls-files | grep -E '^\.env$'` returns
      nothing.
- [ ] **Only `anon`-readable views are public** — `public_village_recovery` and
      `public_fund_transparency`. No raw beneficiary rows.
- [ ] **`--allow-unauthenticated` is understood.** It means Google IAM is not
      gating requests; the app's bearer check is the only gate. That is
      deliberate (probes and public transparency endpoints must be reachable),
      but it puts the whole security burden on `API_TOKEN`.
- [ ] **Secret rotation is possible and rehearsed** — you know the
      `gcloud secrets versions add` incantation above.

Note that while `PERSISTENCE=memory` is live, the service-role key is not in the
request path at all — which lowers the immediate risk but changes none of the
handling rules above, because the key still exists and the seam will close.

**On the auth model, plainly:** bearer-token auth is a stopgap. `API_TOKEN` is a
single shared secret with no identity behind it — every caller is the same
caller. It cannot be revoked per user, it cannot be scoped per NGO or per
village, it produces no meaningful audit trail, and it makes the RLS policies in
`00002_rls_policies.sql` (which key off `auth.jwt() ->> 'ngo_id'`) unreachable,
because the service-role key bypasses them all. It is adequate for a pilot with
a handful of trusted operators and inadequate for anything wider. The intended
destination is Supabase Auth: real per-user JWTs, verified at the edge, with the
anon key and RLS doing the authorization work the policies were written for.
Treat that migration as a prerequisite for onboarding NGOs you do not personally
control.

---

## 9. Troubleshooting

**Container fails to start / "container failed to listen on the port defined by
the PORT environment variable"**

Cloud Run injects `PORT` and requires a listener on `0.0.0.0:$PORT` within the
startup window. The two usual causes: something set `PORT` explicitly in
`--set-env-vars` (remove it — the platform owns that variable), or the app bound
`127.0.0.1` instead of `0.0.0.0`, which is unreachable from outside the
container. Also check for a crash during startup — a thrown error while wiring
the composition root looks identical from the outside:

```bash
gcloud run services logs read afrip-api --project e-vidhayak --region europe-west2 --limit 100
```

The specific startup failures, and what they look like in the log:

| Log line | Cause |
|---|---|
| `[api] configuration error: PERSISTENCE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set` | Supabase mode without both variables |
| `[api] configuration error: PORT must be an integer between 0 and 65535` | A bad `PORT` override — remove it and let Cloud Run inject it |
| `[api] configuration error: PERSISTENCE must be "memory" or "supabase"` | Typo in the value |

Reproduce locally with the same contract:

```bash
docker build -t afrip-api .
docker run --rm -p 8080:8080 -e PERSISTENCE=memory -e API_TOKEN=local afrip-api
curl -fsS localhost:8080/health
```

**Cloud Build failure**

```bash
gcloud builds list --project e-vidhayak --limit 5
gcloud builds log <BUILD_ID> --project e-vidhayak
```

- *"npm ci can only install packages when your package.json and
  package-lock.json are in sync … Missing: @afrip/&lt;pkg&gt; from lock file"* — a
  workspace was added without refreshing the lockfile. This is the most likely
  build failure in an actively developed monorepo. Fix and commit:

  ```bash
  npm install --package-lock-only
  ```

- *"npm ci can only install with an existing package-lock.json"* — the lockfile
  did not reach the build context. Check `.gcloudignore` and `.dockerignore`; the
  root `package.json`, `package-lock.json` and every `packages/*/package.json`
  must be present for npm workspaces to resolve.
- *"Cannot find module packages/api/src/server.ts"* — `packages/api` was not
  uploaded, or the build ran before that package landed.
- *Permission denied pushing the image* — enable `artifactregistry.googleapis.com`
  and confirm your account has `roles/artifactregistry.writer`.

**Supabase connection refused / timeouts**

Check `SUPABASE_URL` has the `https://` scheme and no trailing slash. Confirm the
project is not paused (free-tier projects pause after inactivity — resume it in
the dashboard). Confirm the secret actually mounted:

```bash
gcloud run services describe afrip-api --project e-vidhayak --region europe-west2 \
  --format='yaml(spec.template.spec.containers[0].env)'
```

If a secret fails to mount the revision never becomes ready, and the failure
reads as a generic startup error rather than a permissions one — the fix is
almost always the missing `roles/secretmanager.secretAccessor` grant in step 3.

**401 on every request**

Compare what the container has against what you are sending:

```bash
gcloud secrets versions access latest --secret=afrip-api-token --project e-vidhayak | xxd | tail -2
```

A trailing newline is the usual culprit — hence `printf '%s'` rather than `echo`
everywhere above. Note the API trims surrounding whitespace when reading
`API_TOKEN`, so a stray newline in the *secret* is tolerated; one in the value
you `curl` with is not. Also confirm the header form is exactly
`Authorization: Bearer <token>`, and that the revision serving traffic is the one
deployed after the secret was set (`gcloud run revisions list`).

**No 401 where you expected one** — `curl $URL/health` and read the `auth` field.
`"disabled"` means `API_TOKEN` is absent or empty in that revision.

**401 where you expected none** — `/health`, `/ready` and `/public/*` are
unauthenticated by design, for platform probes and the transparency endpoints. If
`/health` is gated, startup probes fail and the revision never goes live.

**Missing migrations / "relation does not exist"**

The API is talking to a database that has not been migrated, or has only
`00001` applied.

```bash
supabase migration list          # remote state
supabase db push                 # apply anything outstanding
```

Or re-run the two SQL files in order via the dashboard SQL editor. If `00002`
was skipped, tables exist but RLS is off and the public views are missing —
`/public/villages` will fail while authenticated endpoints appear to work, which
is a dangerous combination to leave running.

---

## Reference

| Path | What it is |
|---|---|
| `Dockerfile` | Multi-stage build; runtime ships only `dist/server.js` as non-root |
| `.dockerignore` / `.gcloudignore` | Build-context and upload exclusions |
| `scripts/deploy-cloudrun.sh` | One-command Cloud Run deploy |
| `netlify.toml`, `netlify/functions/api.mts` | The Netlify alternative |
| `.env.example` | Every environment variable, annotated |
| `supabase/migrations/` | The deployable schema (ADR 0004) |
| `docs/adr/` | Why the architecture is the way it is |
