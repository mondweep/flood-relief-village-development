/**
 * Netlify Function wrapping the AFRIP API.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, HONESTLY
 * ---------------------------------------------------------------------------
 * This is an adapter, not a port. `packages/api` is a long-lived node:http
 * server; Netlify Functions are AWS Lambda. The impedance mismatch is real and
 * this file does not paper over it:
 *
 *   1. NO LONG-LIVED PROCESS. The server is booted inside a Lambda container
 *      and lives only as long as that container. Netlify recycles containers
 *      freely and runs several in parallel under load.
 *
 *   2. THE EVENT BUS DOES NOT SURVIVE. `createPlatform()` in
 *      @afrip/platform wires bounded contexts over an in-process
 *      InMemoryEventBus. Each Lambda container gets its OWN bus. An event
 *      published while handling request A is delivered to the handlers in that
 *      container only, and is gone once the container dies. Any handler whose
 *      effect is not written through to a shared datastore before the response
 *      is returned is silently lost.
 *
 *      This is the sharpest edge right now: `memory` on Lambda means every
 *      container has its own private, empty, disposable world, because the
 *      bus does not survive between invocations. `PERSISTENCE=supabase` is
 *      wired and avoids this — state lives in Postgres, not in a
 *      per-container bus — and is the mode to use for anything beyond a
 *      quick demo.
 *
 *   3. EXECUTION TIME LIMITS. Synchronous Netlify Functions are killed at 10s
 *      (26s on some plans). Cloud Run's request timeout is 300s by default.
 *
 *   4. COLD STARTS. The first request into a fresh container pays for booting
 *      the entire composition root, not just the HTTP listener.
 *
 * ---------------------------------------------------------------------------
 * HOW IT WORKS
 * ---------------------------------------------------------------------------
 * On the first invocation in a container we set PORT to a loopback port, import
 * the built bundle, call its exported `main()`, and wait for /health to answer.
 * Subsequent requests are proxied over that loopback socket.
 *
 * NOTE — why `main()` and not a bare side-effect import: `server.ts` guards its
 * bootstrap with
 *
 *     if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
 *
 * so it is deliberately side-effect free unless it IS the process entry point.
 * Under Lambda, `process.argv[1]` is the Netlify/AWS bootstrap, so importing the
 * module alone would never bind a port and every request would time out waiting
 * for a server that was never started. Calling the exported `main()` is what
 * actually boots it.
 *
 * The extra localhost hop costs well under a millisecond and is invisible next
 * to Lambda's own overhead.
 *
 * TODO(perf, optional): `dist/server.js` also exports `createHandler`,
 * `loadConfig` and `createPersistence`. The loopback hop could be removed by
 * calling `createHandler({config, runtime})` directly and bridging Web Request
 * <-> node IncomingMessage/ServerResponse in-process. That bridge is fiddly to
 * get right (streaming bodies, trailers, early hints); the loopback version is
 * chosen here for correctness over micro-optimisation. Revisit only if profiling
 * says it matters.
 */

import type { Config, Context } from "@netlify/functions";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Loopback port the wrapped server listens on inside the Lambda container. */
const INTERNAL_PORT = Number(process.env.AFRIP_INTERNAL_PORT ?? 8787);
const INTERNAL_ORIGIN = `http://127.0.0.1:${INTERNAL_PORT}`;

/** How long to wait for the wrapped server to report healthy on cold start. */
const BOOT_TIMEOUT_MS = Number(process.env.AFRIP_BOOT_TIMEOUT_MS ?? 8_000);

/**
 * Hop-by-hop and Lambda-injected headers that must not be forwarded verbatim.
 * `host` in particular would make the wrapped server think it is serving the
 * public hostname on its loopback socket.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "content-length",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

/**
 * Locate the built bundle. `included_files = ["dist/**"]` in netlify.toml puts
 * it somewhere under the function's root, but the exact base differs between
 * `netlify dev`, `netlify build` and the deployed Lambda — so probe.
 */
function resolveBundle(): string {
  const roots = [
    process.env.LAMBDA_TASK_ROOT,
    process.cwd(),
    // netlify dev runs functions from the repo root
    join(process.cwd(), ".."),
    join(process.cwd(), "../.."),
  ].filter((r): r is string => typeof r === "string" && r.length > 0);

  for (const root of roots) {
    const candidate = join(root, "dist", "server.js");
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Could not find dist/server.js. Looked under: ${roots.join(", ")}. ` +
      `Run "npm run build" before deploying, and keep included_files = ["dist/**"] in netlify.toml.`,
  );
}

/** Poll /health until the wrapped server answers or we run out of patience. */
async function waitForHealthy(deadline: number): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${INTERNAL_ORIGIN}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return;
      lastError = new Error(`/health returned ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Wrapped API did not become healthy on ${INTERNAL_ORIGIN} within ${BOOT_TIMEOUT_MS}ms: ${String(lastError)}`,
  );
}

/**
 * Boot the wrapped server exactly once per Lambda container. The promise is
 * memoised at module scope, so concurrent invocations in the same container all
 * await the same boot instead of racing to bind the port.
 */
let bootPromise: Promise<void> | undefined;

function bootServer(): Promise<void> {
  bootPromise ??= (async () => {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;

    // The contract: the server reads process.env.PORT at import time.
    process.env.PORT = String(INTERNAL_PORT);
    process.env.NODE_ENV ??= "production";

    const bundle = resolveBundle();
    // Computed specifier: deliberately non-analyzable so Netlify's esbuild pass
    // leaves it alone and loads the included file at runtime instead.
    const mod: Record<string, unknown> = await import(pathToFileURL(bundle).href);

    const main = mod["main"];
    if (typeof main !== "function") {
      throw new Error(
        `dist/server.js does not export main(). Exports found: ${Object.keys(mod).join(", ") || "(none)"}. ` +
          `This adapter boots the server by calling that export — see the note at the top of this file.`,
      );
    }

    // main() returns the http.Server, or null when loadConfig() rejected the
    // environment (it logs the specific reason and sets process.exitCode).
    const server = (main as () => unknown)();
    if (server === null || server === undefined) {
      throw new Error(
        "The API rejected its configuration and did not start. Check the function logs for " +
          "'[api] configuration error' or '[api] persistence error'. Most likely: PERSISTENCE=supabase " +
          "without both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set, or the database is unreachable.",
      );
    }

    await waitForHealthy(deadline);
  })().catch((error) => {
    // Do not cache a failed boot — the next invocation should retry rather than
    // serve 500s for the lifetime of the container.
    bootPromise = undefined;
    throw error;
  });

  return bootPromise;
}

export default async function handler(request: Request, _context: Context): Promise<Response> {
  try {
    await bootServer();
  } catch (error) {
    return Response.json(
      { error: "api_boot_failed", detail: String(error instanceof Error ? error.message : error) },
      { status: 502 },
    );
  }

  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, INTERNAL_ORIGIN);

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  // Preserve the caller-facing origin for anything that builds absolute URLs.
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  // Buffered rather than streamed: `duplex: "half"` streaming through the
  // loopback hop is not worth the fragility for JSON payloads of this size.
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      // Stay inside Netlify's 10s synchronous budget so the caller gets a real
      // error instead of Lambda's opaque timeout.
      signal: AbortSignal.timeout(9_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return Response.json(
      {
        error: timedOut ? "upstream_timeout" : "upstream_unreachable",
        detail: timedOut
          ? "The API did not respond within the Netlify Function execution budget. " +
            "This request likely needs Cloud Run, or a Netlify background function."
          : String(error instanceof Error ? error.message : error),
      },
      { status: timedOut ? 504 : 502 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/**
 * Catch-all routing. netlify.toml also declares a `/*` redirect; keeping the
 * paths here too means the function still works with `netlify dev` when
 * redirects are not applied. Narrow both when a frontend is added.
 */
export const config: Config = {
  path: "/*",
};
