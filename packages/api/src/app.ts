import type { IncomingMessage, ServerResponse } from "node:http";
import { authorize } from "./auth.js";
import { readJsonBody } from "./body.js";
import {
  internalError,
  methodNotAllowed,
  notFound,
  writeResponse,
  type HttpResponse,
} from "./http-result.js";
import { buildRouter, type RouteDeps } from "./routes/index.js";

const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Builds the request handler: auth gate, body parsing, routing, and a
 * catch-all that turns any unhandled throw into a 500 with a generic body.
 */
export function createHandler(deps: RouteDeps): RequestListener {
  const router = buildRouter(deps);

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
    // The base is a placeholder: only pathname and search are ever read.
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    const auth = authorize(deps.config, path, req.headers.authorization);
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

    return match.handler({ method, path, params: match.params, query: url.searchParams, body });
  }
}
