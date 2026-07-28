// The dashboard document, authored in packages/web and inlined into this
// bundle as a string by esbuild's `--loader:.html=text` (see src/html.d.ts).
// It is a single self-contained file — inline CSS and JS, no asset requests —
// precisely so that serving it needs no static-file middleware.
import indexHtml from "../../../web/src/index.html";
import { html, type HttpResponse } from "../http-result.js";
import type { Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

/** Re-exported so tests can assert on the markup the server will actually send. */
export const DASHBOARD_HTML: string = indexHtml;

/**
 * Serves the web dashboard at `/` and `/index.html`.
 *
 * Two exact routes, not a catch-all: an unknown path must keep returning the
 * API's JSON 404 so that a client with a typo'd endpoint gets a machine-readable
 * error instead of a 200 full of markup. This is an API that happens to serve
 * one page, not a single-page app with an API bolted on.
 *
 * Unauthenticated — see the exemption list and its rationale in `src/auth.ts`.
 */
export function registerDashboardRoutes(router: Router, _deps: RouteDeps): void {
  const serve = async (): Promise<HttpResponse> => html(DASHBOARD_HTML);

  router.get("/", serve);
  router.get("/index.html", serve);
}
