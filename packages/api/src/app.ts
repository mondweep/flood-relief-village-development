import type { IncomingMessage, ServerResponse } from "node:http";
import { createAuthGate, type AuthGate } from "./auth.js";
import { readJsonBody } from "./body.js";
import {
  badRequest,
  internalError,
  methodNotAllowed,
  notFound,
  writeResponse,
  type HttpResponse,
} from "./http-result.js";
import { buildRouter, type RouteDeps } from "./routes/index.js";

const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

/** Placeholder origin: only pathname and search are ever read off the result. */
const ORIGIN = "http://localhost";

/**
 * Parses a request-target into a URL.
 *
 * `new URL(target, ORIGIN)` is wrong here: an origin-form target beginning with
 * two slashes is a perfectly legal path, but relative-URL resolution reads it as
 * protocol-relative — `//villages` becomes host `villages` with path `/`, and a
 * bare `//` throws outright (a 500 for a well-formed request). Anchoring the
 * target onto the origin keeps a path a path, which also keeps the auth gate and
 * the router looking at the same string. Returns null for a target so malformed
 * that even that fails, so the caller can answer 400 instead of 500.
 */
function parseRequestUrl(rawTarget: string): URL | null {
  const target = rawTarget.startsWith("/") ? rawTarget : `/${rawTarget}`;
  try {
    return new URL(`${ORIGIN}${target}`);
  } catch {
    return null;
  }
}

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Builds the request handler: auth gate, body parsing, routing, and a
 * catch-all that turns any unhandled throw into a 500 with a generic body.
 */
export function createHandler(deps: RouteDeps): RequestListener {
  // Built once per handler, not per request: the JWKS key set it holds is
  // cached inside it, and a gate rebuilt per request would re-fetch keys on
  // every call — exactly the per-request round trip to Supabase ADR 0008 rules out.
  const gate: AuthGate =
    deps.auth ?? createAuthGate({ config: deps.config, profiles: deps.runtime.profiles ?? null });

  // The routes get the gate that is actually enforcing, so `/health` and
  // `/public/config` report the door that is really there rather than the one
  // the configuration implies.
  const router = buildRouter({ ...deps, auth: gate });

  return (req, res) => {
    void dispatch(req)
      .then((response) => writeResponse(res, response))
      .catch((error: unknown) => {
        // The client learns nothing; the operator gets the detail in the log.
        console.error("[api] unhandled request error", error);
        writeResponse(res, internalError());
      });
  };

  async function dispatch(req: IncomingMessage): Promise<HttpResponse> {
    const method = req.method ?? "GET";
    const url = parseRequestUrl(req.url ?? "/");
    if (url === null) return badRequest("malformed request target");
    const path = url.pathname;

    const auth = await gate.authorize(path, req.headers.authorization);
    if (!auth.authorized) return auth.response;

    const match = router.match(method, path);
    if (match === null) {
      return router.hasPath(path)
        ? methodNotAllowed(`method not allowed: ${method} ${path}`)
        : notFound(`not found: ${method} ${path}`);
    }

    let body: unknown;
    if (BODY_METHODS.has(method.toUpperCase())) {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return parsed.error;
      body = parsed.value;
    }

    return match.handler({
      method,
      path,
      params: match.params,
      query: url.searchParams,
      body,
      actor: auth.actor,
    });
  }
}
