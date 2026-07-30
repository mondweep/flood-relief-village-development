#!/usr/bin/env bash
#
# deploy-cloudrun.sh — build and deploy the AFRIP API to Google Cloud Run.
#
# Usage:
#   ./scripts/deploy-cloudrun.sh
#
# Everything is parameterised via the environment; the defaults are the real
# values for this project, so a plain invocation is the happy path:
#
#   PROJECT_ID   GCP project                       (default: e-vidhayak)
#   REGION       Cloud Run region                  (default: europe-west2)
#   SERVICE      Cloud Run service name            (default: afrip-api)
#   PERSISTENCE  memory | supabase                 (default: supabase)
#   SUPABASE_URL https://<ref>.supabase.co         (required when supabase)
#   MIN_INSTANCES / MAX_INSTANCES / MEMORY / CPU / CONCURRENCY / TIMEOUT
#
# Secrets are NEVER passed as env vars. Set them once in this shell to seed
# Secret Manager, then never again:
#
#   SUPABASE_SERVICE_ROLE_KEY=eyJ... API_TOKEN=$(openssl rand -hex 32) \
#     ./scripts/deploy-cloudrun.sh
#
set -euo pipefail

# Some managed/CI environments preset CLOUDSDK_AUTH_ACCESS_TOKEN to a token
# minted for a different purpose. gcloud prefers it over the credentials from
# `gcloud auth login`, so every call fails ACCESS_TOKEN_TYPE_UNSUPPORTED while
# `gcloud auth list` still shows the account as active — a confusing pairing.
# Drop it so the logged-in user's credentials are used.
#
# AFRIP_USE_ACCESS_TOKEN=1 keeps it instead. That is for the opposite situation
# and it is a real one: a headless container where `gcloud auth login` cannot
# prompt, holding a genuine OAuth token obtained out of band. Google enforces
# periodic reauthentication on cloud-platform scope, so stored gcloud
# credentials go stale and the only way back in without a browser is to exchange
# a fresh code and hand the resulting token in here.
#
# The distinction is the token's KIND, which this script cannot inspect — so it
# is the caller's to assert. Set it only when you know the token is a real user
# OAuth token; a wrong one fails with ACCESS_TOKEN_TYPE_UNSUPPORTED at the first
# call, which is loud and costs nothing.
if [[ "${AFRIP_USE_ACCESS_TOKEN:-0}" != "1" ]]; then
  unset CLOUDSDK_AUTH_ACCESS_TOKEN
fi

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PROJECT_ID="${PROJECT_ID:-e-vidhayak}"
REGION="${REGION:-europe-west2}"
SERVICE="${SERVICE:-afrip-api}"

# Default is `supabase`. A real deployment should persist its data; the
# in-memory adapter loses everything on every scale-to-zero, so it is opt-in
# for smoke tests only (PERSISTENCE=memory below). Supabase credentials are
# checked strictly further down: missing SUPABASE_URL or the Secret Manager
# secret is a hard failure before any Cloud Build spend.
PERSISTENCE="${PERSISTENCE:-supabase}"
SUPABASE_URL="${SUPABASE_URL:-}"

# Sizing. See docs/DEPLOYMENT.md for why min-instances=0 is the default.
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-10}"
MEMORY="${MEMORY:-512Mi}"
CPU="${CPU:-1}"
CONCURRENCY="${CONCURRENCY:-80}"
TIMEOUT="${TIMEOUT:-300}"

# Secret Manager secret names (the *names*, not the values).
SECRET_SUPABASE_KEY="afrip-supabase-service-role-key"
SECRET_API_TOKEN="afrip-api-token"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s[warn]%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '\n%s[fatal]%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Step 0 — preflight: gcloud present, authenticated, project reachable
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Step 0a — the regression gate
# ---------------------------------------------------------------------------
# THE SUITE RUNS BEFORE ANYTHING IS BUILT OR SHIPPED. Until this existed the
# script deployed whatever was in the working tree, and the only thing standing
# between a broken build and production was whoever ran it remembering to type
# `npm test` first. That worked for eight consecutive deploys and was luck, not
# process — a regression pack nothing consults is documentation.
#
# It runs FIRST, before the gcloud preflight, deliberately: a failing suite
# should cost nothing and reach no conclusion about your credentials. It also
# runs before Cloud Build, so a broken commit never spends a build minute.
#
# Order within the gate is cheapest-first, so the fastest signal fails soonest:
# typecheck (seconds), then the suite, then the bundle. The bundle is included
# because `npm test` does NOT exercise esbuild — the frontend is inlined by the
# bundler and a build-only failure (a missing loader, an unresolved import) is
# invisible to vitest. That exact class of break has happened here.
#
# SKIP_TESTS=1 exists for one legitimate case: re-running a deploy of a revision
# whose suite has already passed, when only deploy configuration changed. It
# prints a warning naming what was skipped, because a silent skip is how a gate
# stops being one.
if [[ "${SKIP_TESTS:-0}" == "1" ]]; then
  warn "SKIP_TESTS=1 — regression pack NOT run. Nothing has verified this tree."
else
  step "Regression pack (typecheck, ${TEST_LABEL:-full suite}, bundle, migrations)"
  info "Running from ${REPO_ROOT}"
  npm --prefix "$REPO_ROOT" run typecheck >/dev/null 2>&1 \
    || die "typecheck failed. Run 'npm run typecheck' to see it. Nothing was deployed."
  info "typecheck clean"
  npm --prefix "$REPO_ROOT" test >/dev/null 2>&1 \
    || die "the test suite failed. Run 'npm test' to see it. Nothing was deployed."
  info "test suite passed"
  npm --prefix "$REPO_ROOT" run build >/dev/null 2>&1 \
    || die "the bundle failed to build. Run 'npm run build' to see it. Nothing was deployed."
  info "bundle built"

  # MIGRATION SAFETY, and it is last in the gate for a reason: it is the most
  # expensive check (it starts a PostgreSQL cluster) and it is also the one
  # guarding the only thing here with no undo. A bad revision rolls back with
  # `update-traffic`; a `drop column` takes the data with it, and this project
  # has already lost a village record it could not get back.
  #
  # It checks that migration numbering is contiguous, that no already-applied
  # migration has been edited since, and that the whole set applies to an empty
  # database twice over. See scripts/check-migrations.sh for what it deliberately
  # does NOT prove — in particular that it rehearses against an EMPTY database,
  # so a constraint that only fails against real rows still fails in production.
  #
  # SKIP_REHEARSAL=1 is honoured by that script and drops the third check when
  # no PostgreSQL is available; it warns, and the first two still run.
  "$REPO_ROOT/scripts/check-migrations.sh" >/dev/null 2>&1 \
    || die "the migration check failed. Run 'scripts/check-migrations.sh' to see it. Nothing was deployed."
  info "migrations rehearsed"
fi

step "Preflight checks"

command -v gcloud >/dev/null 2>&1 || die \
"gcloud CLI not found on PATH.
  Install it: https://cloud.google.com/sdk/docs/install
  macOS:  brew install --cask google-cloud-sdk
  Debian: sudo apt-get install google-cloud-cli"

info "gcloud: $(gcloud version --format='value(\"Google Cloud SDK\")' 2>/dev/null || echo 'unknown version')"

# An "active" account is one gcloud will actually use for API calls.
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1 || true)"
[[ -n "$ACTIVE_ACCOUNT" ]] || die \
"No active gcloud credentials.
  Run:  gcloud auth login mondweep@dxsure.uk
  (CI/headless: gcloud auth activate-service-account --key-file=KEY.json)"
info "Authenticated as: ${ACTIVE_ACCOUNT}"

[[ -n "$PROJECT_ID" ]] || die "PROJECT_ID is empty. Export PROJECT_ID=e-vidhayak (or your project) and retry."

# Fails loudly and specifically when the project is wrong or unreachable,
# rather than letting a later gcloud command emit a generic 403.
if ! gcloud projects describe "$PROJECT_ID" --format='value(projectId)' >/dev/null 2>&1; then
  die \
"Cannot access GCP project '${PROJECT_ID}' as ${ACTIVE_ACCOUNT}.
  Either the project id is wrong, or this account has no access, or billing/the
  Resource Manager API is off.
    List what you can see:  gcloud projects list
    Switch account:         gcloud auth login mondweep@dxsure.uk
    Override the project:   PROJECT_ID=<other> ./scripts/deploy-cloudrun.sh"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
info "Project: ${PROJECT_ID} (number ${PROJECT_NUMBER})"
info "Region:  ${REGION}"
info "Service: ${SERVICE}"

[[ -f "${REPO_ROOT}/Dockerfile" ]] || die "No Dockerfile at ${REPO_ROOT}/Dockerfile — run this script from the repo."

# Config sanity. loadConfig() in packages/api rejects PERSISTENCE=supabase
# unless BOTH SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are present, and exits
# non-zero — so catch it here rather than after a five-minute Cloud Build.
if [[ "$PERSISTENCE" == "supabase" && -z "$SUPABASE_URL" ]]; then
  die \
"PERSISTENCE=supabase but SUPABASE_URL is unset.
  Find it in the Supabase dashboard: Project Settings -> Data API -> Project URL.
    export SUPABASE_URL=https://<your-project-ref>.supabase.co"
fi

# PERSISTENCE must be one of the two supported values — catch a typo here
# rather than after a five-minute Cloud Build.
if [[ "$PERSISTENCE" != "supabase" && "$PERSISTENCE" != "memory" ]]; then
  die \
"PERSISTENCE must be \"memory\" or \"supabase\" (got '${PERSISTENCE}').
  export PERSISTENCE=supabase   # persistent, recommended
  export PERSISTENCE=memory     # smoke tests only, see warning below"
fi

# memory mode is real, and loudly opt-in only: every scale-to-zero (the
# default MIN_INSTANCES=0) throws away all state, and nothing is shared
# between concurrent instances either. There is no scenario where this is
# safe for anything but a smoke test.
if [[ "$PERSISTENCE" == "memory" ]]; then
  warn \
"PERSISTENCE=memory selected. ALL DATA IS LOST on every scale-to-zero and is
         NOT shared between concurrent instances. This mode exists for smoke
         tests only — never point real NGO or beneficiary data at it.
         For a real deployment: PERSISTENCE=supabase (the default)."
fi

# ---------------------------------------------------------------------------
# Step 1 — pin the active project so every later command is unambiguous
# ---------------------------------------------------------------------------
step "Setting active project"
gcloud config set project "$PROJECT_ID" --quiet
gcloud config set run/region "$REGION" --quiet

# ---------------------------------------------------------------------------
# Step 2 — enable the APIs this deploy touches
# ---------------------------------------------------------------------------
# run             — the service itself
# cloudbuild      — builds the container from source
# artifactregistry— stores the built image
# secretmanager   — holds the service-role key and API token
step "Enabling required APIs (idempotent, may take a minute on first run)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project "$PROJECT_ID"

# ---------------------------------------------------------------------------
# Step 3 — Secret Manager
# ---------------------------------------------------------------------------
# Rule: secrets go through Secret Manager and are mounted with --set-secrets.
# They are NEVER put in --set-env-vars, because env vars are readable by anyone
# with run.services.get on the project and are printed in `gcloud run services
# describe`, in the Cloud Console, and in deployment logs.
#
# ensure_secret <secret-name> <value-or-empty>
#   - creates the secret if absent
#   - adds a new version only when a value was supplied in this invocation
#   - returns 1 (not fatal) if the secret does not exist and no value was given
ensure_secret() {
  local name="$1" value="${2:-}"
  local exists=0
  # NB: written as an if-block, not `cmd && exists=1`. Under `set -e` a bare
  # `a && b` list that fails aborts the whole script.
  if gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    exists=1
  fi

  if [[ "$exists" -eq 0 ]]; then
    if [[ -z "$value" ]]; then
      return 1
    fi
    info "Creating secret '${name}'"
    gcloud secrets create "$name" \
      --project "$PROJECT_ID" \
      --replication-policy=automatic \
      --quiet
  fi

  if [[ -n "$value" ]]; then
    info "Adding new version to secret '${name}'"
    # printf %s (no trailing newline) — a stray \n in a bearer token or JWT is a
    # classic source of "works locally, 401 in prod".
    printf '%s' "$value" | gcloud secrets versions add "$name" \
      --project "$PROJECT_ID" \
      --data-file=- \
      --quiet >/dev/null
  else
    info "Secret '${name}' already exists; keeping current version"
  fi
  return 0
}

step "Reconciling Secret Manager secrets"

# Populated with `ENV_NAME=secret-name:version` pairs for --set-secrets.
# SECRET_COUNT is tracked separately so no `${arr[@]}` expansion of a possibly
# empty array is needed (that is an unbound-variable error under `set -u` on
# bash 3.2, which is still what macOS ships).
SECRET_FLAGS=()
SECRET_COUNT=0

if ensure_secret "$SECRET_SUPABASE_KEY" "${SUPABASE_SERVICE_ROLE_KEY:-}"; then
  SECRET_FLAGS+=("SUPABASE_SERVICE_ROLE_KEY=${SECRET_SUPABASE_KEY}:latest")
  SECRET_COUNT=$((SECRET_COUNT + 1))
else
  if [[ "$PERSISTENCE" == "supabase" ]]; then
    die \
"PERSISTENCE=supabase but secret '${SECRET_SUPABASE_KEY}' does not exist and no
value was supplied. Seed it once:

  SUPABASE_SERVICE_ROLE_KEY='eyJ...' ./scripts/deploy-cloudrun.sh

or create it by hand:

  printf '%s' 'eyJ...' | gcloud secrets create ${SECRET_SUPABASE_KEY} \\
    --project ${PROJECT_ID} --replication-policy=automatic --data-file=-

The service-role key is in the Supabase dashboard under
Project Settings -> API keys -> service_role. It bypasses RLS: server-side only."
  else
    warn "No Supabase secret configured — fine for PERSISTENCE=memory."
  fi
fi

# LEGACY_API_TOKEN=off retires the shared static token (ADR 0008's transitional
# concession). Retiring it is the POINT of ADR 0008, and specifically of ADR
# 0009: a request carrying the shared token arrives with no actor at all, and a
# null actor is ALLOWED through every permission check by design — so while the
# token is live, role enforcement and the beneficiary-register lockout do not
# apply to anyone holding it. It also identifies nobody, so nothing that request
# does can be attributed in the audit trail.
#
# The secret itself is left in Secret Manager, unmounted. Deleting it would make
# a rollback to a pre-0008 revision fail to start, and those revisions are the
# rollback path for the deploy that retires it.
if [[ "${LEGACY_API_TOKEN:-on}" == "off" ]]; then
  info "LEGACY_API_TOKEN=off — the shared static token will NOT be mounted."
  info "Every caller must now sign in; /health will report auth=supabase-jwt."
elif ensure_secret "$SECRET_API_TOKEN" "${API_TOKEN:-}"; then
  SECRET_FLAGS+=("API_TOKEN=${SECRET_API_TOKEN}:latest")
  SECRET_COUNT=$((SECRET_COUNT + 1))
  warn \
"The shared API_TOKEN is still mounted. It identifies nobody and bypasses ADR
         0009's role checks entirely (a null actor is allowed everywhere), so the
         beneficiary register is reachable by anyone holding it. Retire it with:
           LEGACY_API_TOKEN=off ./scripts/deploy-cloudrun.sh"
else
  warn \
"Secret '${SECRET_API_TOKEN}' does not exist and no API_TOKEN was supplied.
         With AUTH_JWT on this is fine — callers sign in instead. With AUTH_JWT
         off it would deploy write endpoints UNAUTHENTICATED."
fi

# ---------------------------------------------------------------------------
# Step 4 — let the runtime service account read those secrets
# ---------------------------------------------------------------------------
# Without secretAccessor the revision fails to start with a mount error rather
# than anything obviously permission-shaped, so grant it explicitly.
if [[ "$SECRET_COUNT" -gt 0 ]]; then
  step "Granting Secret Manager access to the Cloud Run runtime service account"
  RUNTIME_SA="${SERVICE_ACCOUNT:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"
  info "Runtime service account: ${RUNTIME_SA}"
  for flag in "${SECRET_FLAGS[@]}"; do
    secret_name="${flag#*=}"; secret_name="${secret_name%%:*}"
    gcloud secrets add-iam-policy-binding "$secret_name" \
      --project "$PROJECT_ID" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role="roles/secretmanager.secretAccessor" \
      --condition=None \
      --quiet >/dev/null
    info "  ${secret_name}: secretAccessor granted"
  done
fi

# ---------------------------------------------------------------------------
# Step 5 — build from source and deploy
# ---------------------------------------------------------------------------
# --source . makes Cloud Build build the repo Dockerfile and push the image to
# Artifact Registry, then deploys the resulting image as a new revision.
#
# NOTE on --port: Cloud Run injects PORT into the container and expects the app
# to bind 0.0.0.0:$PORT. packages/api reads `process.env.PORT ?? 8080`, so the
# contract holds; --port 8080 just keeps the declared container port aligned
# with the Dockerfile's EXPOSE.
step "Building and deploying (Cloud Build; first run takes a few minutes)"

ENV_VARS="NODE_ENV=production,PERSISTENCE=${PERSISTENCE}"
if [[ -n "$SUPABASE_URL" ]]; then
  ENV_VARS="${ENV_VARS},SUPABASE_URL=${SUPABASE_URL}"
fi

# Identity (ADR 0008). AUTH_JWT defaults ON in loadConfig the moment SUPABASE_URL
# is set, so this is passed explicitly to make the choice visible in the revision
# rather than implied by the absence of a variable.
ENV_VARS="${ENV_VARS},AUTH_JWT=${AUTH_JWT:-on}"

# Stamp the source revision, so /health — and the page footer that reads it —
# name the branch actually serving rather than one written into the markup.
# `--source` uploads the WORKING TREE, so this reports what was really shipped,
# including any uncommitted change; `-dirty` is appended when that is the case,
# because a commit id that silently omits local edits is a false provenance.
GIT_BRANCH="${GIT_BRANCH:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"
GIT_COMMIT="${GIT_COMMIT:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
  GIT_COMMIT="${GIT_COMMIT}-dirty"
  warn "Working tree has uncommitted changes; deploying them as ${GIT_COMMIT}."
fi
GIT_REPOSITORY="${GIT_REPOSITORY:-https://github.com/mondweep/flood-relief-village-development}"
ENV_VARS="${ENV_VARS},GIT_BRANCH=${GIT_BRANCH},GIT_COMMIT=${GIT_COMMIT},GIT_REPOSITORY=${GIT_REPOSITORY}"
info "Source revision: ${GIT_BRANCH} @ ${GIT_COMMIT}"

# The PUBLISHABLE (anon) key is NOT a secret and is deliberately an env var: the
# browser needs it to talk to GoTrue at all, and `GET /public/config` serves it
# to every visitor. Putting it in Secret Manager would imply a confidentiality it
# does not have, and would cost a secret access on every cold start to publish a
# value that is already public. The SERVICE-ROLE key is the opposite and stays in
# Secret Manager below — do not confuse the two.
#
# INHERITED FROM THE RUNNING SERVICE WHEN THE CALLER SUPPLIES NONE, and that is
# not a convenience — it is a fix for a fault that took sign-in down.
#
# `gcloud run deploy --set-env-vars` REPLACES the environment; it does not merge.
# So every variable this script does not pass is silently REMOVED from the
# service. This one used to be forwarded only when it happened to be exported in
# the operator's shell, which meant a redeploy from a fresh terminal — the normal
# case — blanked it. `GET /public/config` then answered
# `supabasePublishableKey: null`, the page rendered "Accounts are not available
# on this deployment", and nobody could sign in. Deploy reported success, the
# smoke test passed, `/health` was green. That happened, to real users.
#
# Reading the live value back means a redeploy preserves what is already
# working, and only a caller who explicitly supplies a different key changes it.
#
# `gcloud run services describe --filter` does not exist, and the `.filter()`
# format transform takes different arguments than its docs suggest — both were
# tried. The flattened text form is stable and needs no jq, so it is parsed
# directly. A variable that is absent yields the empty string, which is exactly
# what the callers below test for.
read_service_env() {
  gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
    --format='value[delimiter="
"](spec.template.spec.containers[0].env)' 2>/dev/null \
  | sed -n "s/^{'name': '$1', 'value': '\(.*\)'}$/\1/p" | head -1
}

if [[ -z "${SUPABASE_PUBLISHABLE_KEY:-}" ]]; then
  SUPABASE_PUBLISHABLE_KEY="$(read_service_env SUPABASE_PUBLISHABLE_KEY || true)"
  if [[ -n "$SUPABASE_PUBLISHABLE_KEY" ]]; then
    info "Reusing the SUPABASE_PUBLISHABLE_KEY already on ${SERVICE}."
  fi
fi

# A deployment with JWT auth on and no publishable key is one nobody can sign
# into. It looks entirely healthy from the outside, which is exactly why this is
# a hard failure rather than a warning — the last warning in this script was read
# past by the person it was written for.
if [[ "${AUTH_JWT:-on}" != "off" && -z "${SUPABASE_PUBLISHABLE_KEY:-}" ]]; then
  die \
"AUTH_JWT is on but no SUPABASE_PUBLISHABLE_KEY is set, and none is on the
  running service. The browser cannot reach Supabase Auth without it, so the
  sign-in panel would render 'Accounts are not available on this deployment'
  and there would be no way in.

  Supply it (it is publishable, not secret — GET /public/config serves it to
  every visitor):

    SUPABASE_PUBLISHABLE_KEY=sb_publishable_... ./scripts/deploy-cloudrun.sh

  Supabase dashboard → Project Settings → API keys. Nothing was deployed."
fi

if [[ -n "${SUPABASE_PUBLISHABLE_KEY:-}" ]]; then
  ENV_VARS="${ENV_VARS},SUPABASE_PUBLISHABLE_KEY=${SUPABASE_PUBLISHABLE_KEY}"
fi

# Which social providers the sign-in page offers. It only draws buttons; enabling
# a provider is done in the Supabase dashboard, and listing one here that is not
# configured there produces a button that fails on click.
#
# Inherited from the running service for the same reason as the key above: a
# redeploy that drops it does not break sign-in outright, it just quietly removes
# the Google button, which is worse — it looks like a design change.
if [[ -z "${AUTH_PROVIDERS:-}" ]]; then
  AUTH_PROVIDERS="$(read_service_env AUTH_PROVIDERS || true)"
  if [[ -n "$AUTH_PROVIDERS" ]]; then
    info "Reusing the AUTH_PROVIDERS already on ${SERVICE}: ${AUTH_PROVIDERS}"
  fi
fi
if [[ -n "${AUTH_PROVIDERS:-}" ]]; then
  ENV_VARS="${ENV_VARS},AUTH_PROVIDERS=${AUTH_PROVIDERS}"
fi

DEPLOY_ARGS=(
  run deploy "$SERVICE"
  --source "$REPO_ROOT"
  --project "$PROJECT_ID"
  --region "$REGION"
  --platform managed
  --port 8080
  --allow-unauthenticated          # app-level bearer auth; /health must stay open
  --min-instances "$MIN_INSTANCES"
  --max-instances "$MAX_INSTANCES"
  --memory "$MEMORY"
  --cpu "$CPU"
  --concurrency "$CONCURRENCY"
  --timeout "$TIMEOUT"
  --set-env-vars "$ENV_VARS"
  --quiet
)

if [[ "$SECRET_COUNT" -gt 0 ]]; then
  DEPLOY_ARGS+=(--set-secrets "$(IFS=,; echo "${SECRET_FLAGS[*]}")")
fi

if [[ -n "${SERVICE_ACCOUNT:-}" ]]; then
  DEPLOY_ARGS+=(--service-account "$SERVICE_ACCOUNT")
fi

gcloud "${DEPLOY_ARGS[@]}"

# ---------------------------------------------------------------------------
# Step 6 — report and smoke test
# ---------------------------------------------------------------------------
step "Deployed"

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" \
  --format='value(status.url)')"
REVISION="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" \
  --format='value(status.latestReadyRevisionName)')"

printf '    %sService URL:%s %s\n' "$GREEN" "$RESET" "$SERVICE_URL"
printf '    Revision:    %s\n' "$REVISION"

step "Smoke test: GET ${SERVICE_URL}/health"
if command -v curl >/dev/null 2>&1; then
  # -f so a 5xx makes this visible; the || block keeps the script's exit code
  # meaningful without hiding the failure.
  if curl -fsS --max-time 30 "${SERVICE_URL}/health"; then
    printf '\n    %shealth OK%s\n' "$GREEN" "$RESET"
  else
    printf '\n'
    die \
"/health did not return 2xx.
  Inspect startup logs:
    gcloud run services logs read ${SERVICE} --project ${PROJECT_ID} --region ${REGION} --limit 100
  Common causes: the container did not bind 0.0.0.0:\$PORT within the startup
  timeout, or a secret failed to mount. See docs/DEPLOYMENT.md#troubleshooting."
  fi
else
  warn "curl not installed; skipping smoke test. Check manually: ${SERVICE_URL}/health"
fi

cat <<EOF

Next:
  Readiness :  curl -fsS ${SERVICE_URL}/ready
  Public API:  curl -fsS ${SERVICE_URL}/public/villages
  Authed call: curl -fsS -H "Authorization: Bearer \$API_TOKEN" ${SERVICE_URL}/villages
  Live logs :  gcloud run services logs tail ${SERVICE} --project ${PROJECT_ID} --region ${REGION}
EOF
