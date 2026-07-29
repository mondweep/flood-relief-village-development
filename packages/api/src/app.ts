import type { IncomingMessage, ServerResponse } from "node:http";
import { isForbiddenThrown } from "@afrip/platform";
import { createAuthGate, type AuthGate } from "./auth.js";
import { readJsonBody } from "./body.js";
import {
  badRequest,
  forbidden,
  internalError,
  methodNotAllowed,
  notFound,
  writeResponse,
  type HttpResponse,
} from "./http-result.js";
import { newRequestId, platformForRequest } from "./request-platform.js";
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
        // A denied READ PORT throws rather than returning a Result — those ports
        // hand back raw values, so a rejected promise is the only refusal channel
        // they have (ADR 0009, see `ForbiddenError`). Recognised structurally
        // rather than with `instanceof`, which breaks the moment the bundled and
        // source copies of the module differ and would quietly downgrade a
        // refusal to a 500.
        if (isForbiddenThrown(error)) {
          writeResponse(res, forbidden(error.message));
          return;
        }
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

    // ADR 0010: the actor established above is carried the rest of the way by
    // composition, not by a parameter on forty-odd use cases. ADR 0009 then
    // gates that composed platform on what the actor may do. Wiring only — the
    // repositories, the Supabase client and the JWKS key set were all built once
    // at startup and are injected in; see the invariant note in
    // request-platform.ts before adding anything expensive to `createPlatform`.
    const requestId = newRequestId();
    const platform = platformForRequest(
      deps.runtime.platform,
      auth.actor ?? null,
      gate.mode,
      requestId,
      deps.runtime.ownership,
      auth.unenrolled === true,
    );

    return match.handler({
      method,
      path,
      params: match.params,
      query: url.searchParams,
      body,
      actor: auth.actor,
      ...(auth.claims === undefined ? {} : { claims: auth.claims }),
      ...(auth.unenrolled === true ? { unenrolled: true } : {}),
      platform,
      requestId,
    });
  }
}
