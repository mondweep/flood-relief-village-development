# syntax=docker/dockerfile:1
#
# AFRIP API — production container.
#
# Three stages:
#   1. manifests — strips the monorepo down to just its package.json files so the
#      expensive `npm ci` layer is only invalidated when a manifest changes.
#   2. builder   — installs (dev deps included, esbuild lives there) and bundles.
#   3. runtime   — ships ONLY dist/, with NO node_modules at all.
#
# That last point was verified against the real build, not assumed:
#   - `npm run build` emits a ~91 KB single-file ESM bundle;
#   - the only import specifiers surviving in it are node: builtins
#     (node:http, node:url, node:crypto). @afrip/* workspaces are inlined and
#     @supabase/supabase-js is not referenced at all, because
#     packages/api/src/persistence.ts has not wired the Supabase adapters yet;
#   - the bundle was executed in a directory containing nothing but server.js
#     and a {"type":"module"} package.json, and served /health, /ready,
#     /public/villages and an authenticated route correctly.
#
# => Adding node_modules to the runtime stage would be pure bloat TODAY. When
# the Supabase seam is filled in, re-check: esbuild will inline
# @supabase/supabase-js too (verified separately — it bundles cleanly and needs
# no native addon or `ws`, since Node 22 supplies global fetch and WebSocket),
# so the runtime stage should still need nothing. Re-run the isolation check
# after that lands rather than trusting this comment.
#
# Result: the runtime image is node:22-slim + one ~91 KB .js file. No dev
# dependencies, no source, no lockfile, no node_modules.

# ---------------------------------------------------------------------------
# Stage 1: manifests — workspace package.json files only
# ---------------------------------------------------------------------------
FROM node:22-slim AS manifests
WORKDIR /app

# npm workspaces resolution needs the root manifest, the lockfile, AND every
# packages/*/package.json. Copying `packages/` wholesale and then deleting
# everything that is not a manifest is the only COPY form that preserves the
# directory structure without hard-coding each package name (packages/api is
# still being written by another agent, so the list must stay dynamic).
COPY package.json package-lock.json ./
COPY packages ./packages
RUN find packages -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} +

# ---------------------------------------------------------------------------
# Stage 2: builder — install + bundle
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# Cached as long as no package.json / package-lock.json changed.
COPY --from=manifests /app/ ./

# `npm ci` is strict on purpose: it fails if package-lock.json is out of sync
# with the workspace manifests (e.g. a new packages/* added without running
# `npm install`), rather than silently resolving something different from what
# was tested. If this step fails with "Missing: @afrip/<pkg> from lock file",
# fix it at the source, not here:
#     npm install --package-lock-only
# and commit the updated lockfile.
RUN npm ci --no-audit --no-fund

# Now the sources. .dockerignore keeps node_modules, tests, docs and local
# agent state out, so this layer is small and does not clobber the install.
COPY tsconfig.json ./
COPY packages ./packages

# root package.json "build":
#   esbuild packages/api/src/server.ts --bundle --platform=node --target=node22
#           --format=esm --outfile=dist/server.js
RUN npm run build \
 && node --input-type=module -e "import {statSync} from 'node:fs'; \
      const s = statSync('dist/server.js'); \
      if (s.size < 1024) { console.error('dist/server.js looks empty'); process.exit(1); } \
      console.log('bundled dist/server.js:', (s.size/1024).toFixed(0)+'kb');"

# ---------------------------------------------------------------------------
# Stage 3: runtime — dist/ only, non-root
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# The bundle is ESM. Node 22 would infer that from the syntax, but an explicit
# type=module makes it deterministic rather than dependent on module detection.
# This is the ONLY package.json in the runtime image — it declares no
# dependencies, so nothing from the builder's node_modules is shipped.
RUN printf '{"name":"afrip-api-runtime","private":true,"type":"module"}\n' > package.json

# `node` (uid 1000) ships with the official image. Files stay root-owned and
# world-readable: the process only needs to read them.
COPY --from=builder /app/dist ./dist

USER node

EXPOSE 8080

# Cloud Run ignores Dockerfile HEALTHCHECK (it probes the container port itself,
# and startup/liveness probes are configured on the service). This is here for
# `docker run` / compose / any plain-Docker host. Uses Node's global fetch so
# the image needs neither curl nor wget.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form => node is PID 1 and receives SIGTERM directly from Cloud Run.
# A PID 1 process only acts on SIGTERM if it registers a handler, and this one
# does: server.ts installs SIGTERM/SIGINT handlers that close the listener,
# drain in-flight requests and force-exit after 10s. So no init shim (tini,
# dumb-init) is needed — verified by sending SIGTERM to the running bundle and
# observing "[api] closed cleanly".
CMD ["node", "dist/server.js"]
