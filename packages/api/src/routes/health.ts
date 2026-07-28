import { json, serviceUnavailable, type HttpResponse } from "../http-result.js";
import type { Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

/**
 * Liveness and readiness. Both are unauthenticated: Cloud Run's probes carry no
 * credentials, and a health endpoint that can 401 is a health endpoint that
 * cannot be trusted during an incident.
 */
export function registerHealthRoutes(router: Router, deps: RouteDeps): void {
  router.get("/health", async (): Promise<HttpResponse> =>
    json(200, {
      status: "ok",
      persistence: deps.runtime.mode,
      version: deps.config.version,
      // Surfaced so an operator can see at a glance that the stopgap token gate
      // is switched off in this revision.
      auth: deps.config.apiToken === null ? "disabled" : "bearer",
    }),
  );

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
