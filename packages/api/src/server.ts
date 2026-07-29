import { createServer as createHttpServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createHandler } from "./app.js";
import {
  authModeOf,
  createAuthGate,
  jwtAuthEnabled,
  legacyTokenEnabled,
  LEGACY_TOKEN_WARNING,
  type AuthGate,
} from "./auth.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { createPersistence, type PlatformRuntime } from "./persistence.js";

export { loadConfig, API_VERSION, type ApiConfig, type PersistenceMode } from "./config.js";
export {
  createAuthGate,
  createJwtVerifier,
  isPublicPath,
  USER_ROLES,
  type ActorContext,
  type AuthGate,
  type ProfileDirectory,
  type TokenVerifier,
  type UserRole,
} from "./auth.js";
export { SupabaseProfileDirectory, USER_PROFILES_TABLE } from "./profiles.js";
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
  /** Identity gate; built from config and the runtime when omitted. */
  readonly auth?: AuthGate;
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

  if (!jwtAuthEnabled(config) && !legacyTokenEnabled(config)) {
    console.warn(
      "[api] WARNING: no credential is configured (no Supabase JWT verification, no API_TOKEN) — " +
        "every non-public route is UNAUTHENTICATED. Do not run this configuration anywhere " +
        "reachable from the internet.",
    );
  }

  // ADR 0008: both paths are accepted during the migration, and the legacy one
  // is announced every time the process starts. A weakness nobody is reminded
  // of is a weakness nobody removes.
  if (legacyTokenEnabled(config)) {
    console.warn(`[api] WARNING: ${LEGACY_TOKEN_WARNING}`);
  }

  /**
   * The confusing combination: a Supabase project IS configured (so the sign-in
   * page will happily offer sign-in, and GoTrue will happily issue a token) but
   * this revision is not verifying what it issues. The user then authenticates
   * successfully and is refused on the very next request — either signed
   * straight back out with `token_invalid` when API_TOKEN is set, or waved
   * through anonymously when it is not. Both are worse than a closed door,
   * because they look like they worked.
   *
   * Reachable by accident rather than by intent: SUPABASE_URL is also what
   * PERSISTENCE=supabase needs, so `AUTH_JWT=off` on a durable deployment is one
   * variable away. Found by the frontend agent reasoning about which states its
   * sign-in surface could be offered in; the page now refuses to offer sign-in
   * when `/public/config` reports `jwtEnabled: false`, and this is the same fact
   * told to whoever deployed it.
   */
  if (!config.authJwt && config.supabaseUrl !== null) {
    console.warn(
      "[api] WARNING: AUTH_JWT is off but SUPABASE_URL is configured. Tokens this project " +
        "issues will NOT be verified: a user who signs in successfully is then refused " +
        `(${legacyTokenEnabled(config) ? "401 token_invalid on every request" : "waved through with no identity"}). ` +
        "Set AUTH_JWT=on, or unset SUPABASE_URL if this deployment is not meant to accept sign-in.",
    );
  }

  if (jwtAuthEnabled(config) && config.supabaseJwtSecret === null) {
    console.log(
      "[api] JWT verification uses the project JWKS endpoint only; SUPABASE_JWT_SECRET is unset, " +
        "so HS256-signed (legacy Supabase) tokens will be refused.",
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

  // Built here rather than inside createHandler so a misconfigured key set is a
  // startup failure, not a surprise on the first authenticated request.
  let auth: AuthGate;
  try {
    auth = createAuthGate({ config, profiles: runtime.profiles ?? null });
  } catch (error) {
    console.error(`[api] auth error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return null;
  }

  if (auth.jwtEnabled && runtime.profiles === undefined) {
    console.warn(
      "[api] WARNING: JWT verification is on but this runtime has no user_profiles store " +
        "(PERSISTENCE=memory). Every verified user resolves to role \"citizen\".",
    );
  }

  const server = createServer({ config, runtime, auth });
  installShutdownHandlers(server);

  server.listen(config.port, HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    console.log(
      `[api] listening on http://${HOST}:${port} — persistence=${runtime.mode} ` +
        `version=${config.version} auth=${auth.mode} legacyToken=${
          auth.legacyTokenEnabled ? "enabled" : "off"
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
