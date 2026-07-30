#!/usr/bin/env bash
#
# check-migrations.sh — rehearse the schema before production ever sees it.
#
# WHY THIS EXISTS.
#
# Everything else in this repository can be undone. A bad revision is one
# `gcloud run services update-traffic` away from the previous one; a bad commit
# is one revert away. A migration is not: `drop column` takes the data with it,
# and the [id-collision incident](docs/incidents/) in this project was already
# unrecoverable once. Migrations are therefore the highest-value thing to gate,
# and gating them is most of what a staging environment would have bought —
# for a fraction of the work, which is why this exists instead of one.
#
# THREE CHECKS, cheapest first, same order as the deploy gate:
#
#   1. numbering    NNNNN_name.sql, unique, contiguous, no gaps
#   2. append-only  an ALREADY-APPLIED migration must never be edited
#   3. rehearsal    apply every migration to an empty database, then apply the
#                   whole set AGAIN, proving both that the schema builds from
#                   nothing and that a re-run changes nothing
#
# WHAT THE REHEARSAL DOES NOT PROVE, stated plainly because a check that is
# believed to cover more than it does is worse than no check:
#
#   * It runs against a bare PostgreSQL, not against Supabase. `auth.uid()`,
#     `auth.jwt()` and the `anon`/`authenticated`/`service_role` roles are
#     STUBBED below. So this proves the DDL is valid and the grants and policies
#     attach to something; it does not prove an RLS policy admits the right rows
#     at runtime.
#   * It runs against an EMPTY database. Production is not empty. A migration
#     that succeeds here can still fail there on a `not null` added to a column
#     with existing nulls, or a unique index over duplicate rows. Rehearsing
#     against a copy of production data is the next increment and is not this.
#   * It says nothing about how long a lock is held. A migration that applies in
#     40ms here can take a table offline for minutes on a real one.
#   * It runs against whatever PostgreSQL is to hand, which on a laptop is often
#     not the major version production runs. The version is printed below for
#     exactly that reason; the CI job pins the matching one.
#
# Usage:
#   scripts/check-migrations.sh                 # all three checks
#   scripts/check-migrations.sh --record        # accept new files into the manifest
#
#   MIGRATION_REHEARSAL_URL=postgres://…        # rehearse against this database
#                                               # (it is DROPPED and recreated)
#   SKIP_REHEARSAL=1                            # checks 1 and 2 only; warns loudly
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
MANIFEST="$ROOT/supabase/migrations.sha256"

RECORD=0
[[ "${1:-}" == "--record" ]] && RECORD=1

info() { printf '\033[36m[migrations]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[fatal]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Numbering
# ---------------------------------------------------------------------------
# Order is the whole contract: 00007 alters a table 00001 creates. A duplicate
# number means two files claim one slot and `*.sql` glob order — not intent —
# decides which runs first. A gap means somebody's migration is not in the repo,
# and the schema that builds here is not the schema anybody has.
info "checking file numbering"

mapfile -t FILES < <(find "$MIGRATIONS" -maxdepth 1 -name '*.sql' -print | sort)
[[ ${#FILES[@]} -gt 0 ]] || fail "no migrations found under $MIGRATIONS"

expected=1
for path in "${FILES[@]}"; do
  name="$(basename "$path")"
  [[ "$name" =~ ^[0-9]{5}_[a-z0-9_]+\.sql$ ]] \
    || fail "$name is not named NNNNN_lower_snake_case.sql"
  number=$((10#${name:0:5}))
  if [[ "$number" -ne "$expected" ]]; then
    fail "expected migration $(printf '%05d' "$expected") next, found $name — a gap or a duplicate number means the order the schema builds in is decided by glob order rather than by intent"
  fi
  expected=$((expected + 1))
done
info "${#FILES[@]} migrations, numbered 00001–$(printf '%05d' $((expected - 1)))"

# ---------------------------------------------------------------------------
# 2. Append-only
# ---------------------------------------------------------------------------
# THE CHECK WITH THE MOST TEETH, and the one that needs the most explaining.
#
# A migration that has been applied to production is history. Editing it does
# not change the database it already ran against — it changes only what a FRESH
# database would build, so the two silently diverge and every later migration is
# written against a schema that exists in exactly one of the two places. That
# divergence is invisible until something fails in production for a reason that
# cannot be reproduced anywhere else.
#
# The manifest is the memory: a sha256 per file, committed. Editing an applied
# migration changes its hash and fails here. Adding a NEW migration also fails
# here, on purpose, until `--record` accepts it — because "is this file new or
# did somebody edit an old one?" is precisely the question worth being explicit
# about, and a manifest that updates itself answers it by never asking.
info "checking that applied migrations have not been edited"

if [[ ! -f "$MANIFEST" ]]; then
  if [[ "$RECORD" -eq 1 ]]; then
    : > "$MANIFEST"
  else
    fail "$MANIFEST does not exist — run 'scripts/check-migrations.sh --record' once to seed it"
  fi
fi

drift=0
for path in "${FILES[@]}"; do
  name="$(basename "$path")"
  actual="$(sha256sum "$path" | cut -d' ' -f1)"
  recorded="$(awk -v f="$name" '$2 == f { print $1 }' "$MANIFEST")"

  if [[ -z "$recorded" ]]; then
    if [[ "$RECORD" -eq 1 ]]; then
      printf '%s  %s\n' "$actual" "$name" >> "$MANIFEST"
      info "recorded $name"
    else
      warn "$name is not in the manifest — if it is new, re-run with --record"
      drift=1
    fi
  elif [[ "$recorded" != "$actual" ]]; then
    # Deliberately NOT fixable with --record. --record only appends; changing a
    # recorded hash means editing the manifest by hand, which is the friction
    # this check is made of.
    printf '\033[31m[fatal]\033[0m %s has been EDITED since it was applied.\n' "$name" >&2
    printf '  recorded %s\n  now      %s\n' "$recorded" "$actual" >&2
    printf '  A migration that has run against production is history. Editing it changes\n' >&2
    printf '  only what a fresh database would build, so production and a new environment\n' >&2
    printf '  diverge silently. Write a NEW migration that makes the change instead.\n' >&2
    drift=1
  fi
done

# A migration deleted from the tree but still in the manifest is the same
# divergence seen from the other side: production has a table nothing in this
# repository creates.
while read -r _hash name; do
  [[ -z "${name:-}" ]] && continue
  [[ -f "$MIGRATIONS/$name" ]] || { warn "$name is in the manifest but no longer in the tree"; drift=1; }
done < "$MANIFEST"

[[ "$drift" -eq 0 ]] || fail "migration history does not match the manifest. Nothing was rehearsed."
info "all migrations match the manifest"

# ---------------------------------------------------------------------------
# 3. Rehearsal
# ---------------------------------------------------------------------------
if [[ "${SKIP_REHEARSAL:-0}" == "1" ]]; then
  warn "SKIP_REHEARSAL=1 — the schema was NOT applied to anything."
  warn "The static checks above passed. Nothing here has proved that the SQL runs."
  exit 0
fi

# Two ways to get a database, in preference order. The URL is what CI uses (a
# service container) and what a developer with a local server uses; the
# throwaway cluster is the fallback so that the common case needs no setup.
CLUSTER=""
cleanup() {
  if [[ -n "$CLUSTER" ]]; then
    pg_ctl -D "$CLUSTER/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$CLUSTER"
  fi
}
trap cleanup EXIT

if [[ -n "${MIGRATION_REHEARSAL_URL:-}" ]]; then
  PSQL=(psql "$MIGRATION_REHEARSAL_URL")
  info "rehearsing against MIGRATION_REHEARSAL_URL"
elif command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
  CLUSTER="$(mktemp -d)"
  info "starting a throwaway PostgreSQL cluster in $CLUSTER"
  initdb -D "$CLUSTER/data" --auth=trust >/dev/null 2>&1 \
    || fail "initdb failed. Set MIGRATION_REHEARSAL_URL to an existing database instead."
  # A unix socket in the cluster directory and no TCP listener at all: this is a
  # throwaway that must not be reachable from anywhere but this script.
  pg_ctl -D "$CLUSTER/data" -o "-k $CLUSTER -c listen_addresses=" -l "$CLUSTER/log" -w start >/dev/null \
    || { cat "$CLUSTER/log" >&2; fail "the throwaway cluster did not start"; }
  PSQL=(psql -h "$CLUSTER" -d postgres)
else
  fail "no database to rehearse against. Install PostgreSQL client+server tools, or set MIGRATION_REHEARSAL_URL, or re-run with SKIP_REHEARSAL=1 to run only the static checks."
fi

# NOTICEs are suppressed, errors are not: `if not exists` and `drop … if exists`
# are used throughout for idempotency, so pass 2 emits one NOTICE per object and
# drowns the output that matters. ON_ERROR_STOP=1 still stops on the first real
# error, which is the thing this script is here to catch.
run_sql() { PGOPTIONS='-c client_min_messages=warning' "${PSQL[@]}" -v ON_ERROR_STOP=1 -q "$@"; }

# The Supabase surface the migrations lean on, stubbed.
#
# These are NOT part of the schema — Supabase provides them — but every RLS
# policy in 00002, 00004 and 00005 calls `auth.uid()` or `auth.jwt()`, and
# `create policy` resolves the function at definition time. Without them the
# rehearsal fails on migration 00002 for a reason that has nothing to do with
# the migration. Stubbing them is what makes the DDL checkable at all; it is
# also exactly why this cannot verify what a policy ADMITS, only that it parses
# and attaches. The bodies return null: a policy evaluated against these matches
# nothing, which is the safe direction for a stub to be wrong in.
rehearse_preamble() {
  run_sql <<'SQL'
drop schema if exists assam_floods cascade;
drop schema if exists auth cascade;
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$;
SQL
  # Roles are cluster-wide, so they survive the schema drop between passes.
  run_sql <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;
SQL
}

apply_all() {
  for path in "${FILES[@]}"; do
    printf '  %s\n' "$(basename "$path")"
    run_sql -f "$path" >/dev/null
  done
}

# Printed, not checked. A mismatch with production is a caveat on the result
# rather than a failure — refusing to rehearse at all because the local server
# is a version behind would leave the developer with no rehearsal, which is
# strictly worse. The CI job is where the version is pinned.
info "server: $(run_sql -tAc 'show server_version')"

info "pass 1 — building the schema from nothing"
rehearse_preamble
apply_all

# PASS 2 IS NOT A FORMALITY.
#
# Migrations get re-run: a deploy is retried, a `psql -f` is repeated after a
# network drop, somebody applies the folder rather than the one new file. Every
# migration here is written to survive that — `if not exists`, `or replace`,
# `drop policy if exists` before `create policy` — and that property is invisible
# on the first pass, when everything is being created anyway. This is the pass
# that fails when a bare `create table` slips in.
info "pass 2 — applying the same set again over the result"
apply_all

# The catalogue, asked rather than assumed. A migration file that ran without
# error but created nothing would pass both passes above in silence.
TABLES="$(run_sql -tAc "select count(*) from pg_tables where schemaname = 'assam_floods'")"
POLICIES="$(run_sql -tAc "select count(*) from pg_policies where schemaname = 'assam_floods'")"
[[ "$TABLES" -gt 0 ]] || fail "the migrations ran but schema assam_floods holds no tables"
[[ "$POLICIES" -gt 0 ]] || fail "the migrations ran but no RLS policy exists on assam_floods"

info "rehearsed twice: $TABLES tables, $POLICIES row-level policies in assam_floods"
info "OK"
