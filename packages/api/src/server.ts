import { createServer as createHttpServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createHandler } from "./app.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { createPersistence, type PlatformRuntime } from "./persistence.js";

export { loadConfig, API_VERSION, type ApiConfig, type PersistenceMode } from "./config.js";
export {
  createPersistence,
  createMemoryRuntime,
  createSupabaseRuntime,
  createSupabaseRuntimeFromClient,
  READY_PROBE_TABLE,
  type PlatformRuntime,
} from "./persistence.js";
export { createHandler } from "./app.js";

/** Cloud Run routes traffic to the container's external interface, so 127.0.0.1 is not enough. */
export const HOST = "0.0.0.0";

/** Grace period for in-flight requests after SIGTERM before the process exits anyway. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ServerDeps {
  readonly config: ApiConfig;
  readonly runtime: PlatformRuntime;
}

/** Builds the HTTP server without binding a port — the seam every test drives. */
export function createServer(deps: ServerDeps): Server {
  return createHttpServer(createHandler(deps));
}

/**
 * Cloud Run sends SIGTERM on scale-down and revision replacement. Closing the
 * listener lets in-flight requests finish; the unref'd timer guarantees we still
 * exit if a connection refuses to drain.
 */
export function installShutdownHandlers(server: Server, exit: (code: number) => void = process.exit): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down`);

    const forced = setTimeout(() => {
      console.warn("[api] shutdown timed out, exiting anyway");
      exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    forced.unref();

    server.close(() => {
      clearTimeout(forced);
      console.log("[api] closed cleanly");
      exit(0);
    });
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/** Boots from the process environment. Returns null when configuration is invalid. */
export function main(): Server | null {
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(`[api] configuration error: ${configResult.error}`);
    process.exitCode = 1;
    return null;
  }
  const config = configResult.value;

  if (config.apiToken === null) {
    console.warn(
      "[api] WARNING: API_TOKEN is not set — every non-public route is UNAUTHENTICATED. " +
        "Do not run this configuration anywhere reachable from the internet.",
    );
  }

  let runtime: PlatformRuntime;
  try {
    runtime = createPersistence(config);
  } catch (error) {
    console.error(`[api] persistence error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return null;
  }

  const server = createServer({ config, runtime });
  installShutdownHandlers(server);

  server.listen(config.port, HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    console.log(
      `[api] listening on http://${HOST}:${port} — persistence=${runtime.mode} version=${config.version} auth=${
        config.apiToken === null ? "disabled" : "bearer"
      }`,
    );
  });

  return server;
}

/**
 * Side-effect free on import (tests import `createServer` directly); binds a port
 * only when this module is the process entry point.
 */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
