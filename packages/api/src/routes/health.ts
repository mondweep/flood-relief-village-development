import { authModeOf, legacyTokenEnabled, LEGACY_TOKEN_WARNING } from "../auth.js";
import { json, serviceUnavailable, type HttpResponse } from "../http-result.js";
import { partialPersistenceOf } from "../persistence.js";
import type { Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

/**
 * Liveness and readiness. Both are unauthenticated: Cloud Run's probes carry no
 * credentials, and a health endpoint that can 401 is a health endpoint that
 * cannot be trusted during an incident.
 */
export function registerHealthRoutes(router: Router, deps: RouteDeps): void {
  router.get("/health", async (): Promise<HttpResponse> => {
    // Present only when the runtime is partly durable. `persistence: "supabase"`
    // on its own would let an operator assume every context survives a restart;
    // four of them do not, and a health endpoint is exactly where that belongs.
    const partial = partialPersistenceOf(deps.runtime);
    // ADR 0008: while the shared static token is still accepted, `/health` must
    // say so. Present only when it IS enabled — the field exists to disclose a
    // transitional weakness, and there is nothing to disclose once it is gone.
    // `auth` already reports which gate is in force in every case.
    //
    // Both facts come off the GATE, not off config: `auth: "disabled"` is read
    // by the dashboard as "this API accepts an uncredentialed request", which is
    // true of the gate's behaviour and only incidentally true of the config.
    const legacy = deps.auth?.legacyTokenEnabled ?? legacyTokenEnabled(deps.config);
    const auditFailures = deps.runtime.auditWriter?.stats().failedWrites ?? 0;
    return json(200, {
      status: "ok",
      persistence: deps.runtime.mode,
      version: deps.config.version,
      // Surfaced so an operator can see at a glance which gate this revision is
      // actually running: per-user JWTs, the legacy shared token, or nothing.
      auth: deps.auth?.mode ?? authModeOf(deps.config),
      // Which source revision is actually serving. Stamped at deploy time from
      // git, so the page's footer can name the branch and commit rather than
      // repeating whatever was hard-coded into the markup — a link to "main"
      // baked into a page built from a feature branch is a lie that survives
      // every review, because nothing about it looks wrong.
      ...(deps.config.build === null ? {} : { build: deps.config.build }),
      // ADR 0011: a silently failing audit log is the exact failure this
      // platform cannot afford, so failures are DISCLOSED rather than only
      // logged. Present only when non-zero — a permanent `auditWriteFailures: 0`
      // becomes wallpaper, and the field exists to be noticed.
      ...(auditFailures === 0
        ? {}
        : {
            auditWriteFailures: auditFailures,
            auditWriteWarning:
              "domain events have been lost from the audit trail. Each is logged in full under " +
              "the marker '[api] AUDIT WRITE FAILED' and can be reinserted from there.",
          }),
      ...(partial === null ? {} : { partialPersistence: partial }),
      ...(legacy ? { legacyTokenEnabled: true, legacyTokenWarning: LEGACY_TOKEN_WARNING } : {}),
    });
  });

  router.get("/ready", async (): Promise<HttpResponse> => {
    const result = await deps.runtime.checkReady();
    if (!result.ok) {
      return serviceUnavailable({
        status: "unavailable",
        persistence: deps.runtime.mode,
        error: result.error,
      });
    }
    return json(200, { status: "ready", persistence: deps.runtime.mode });
  });
}
