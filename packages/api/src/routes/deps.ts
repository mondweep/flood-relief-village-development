import type { AuthGate } from "../auth.js";
import type { ApiConfig } from "../config.js";
import type { PlatformRuntime } from "../persistence.js";

/** Everything a route module is allowed to reach for. */
export interface RouteDeps {
  readonly config: ApiConfig;
  readonly runtime: PlatformRuntime;
  /**
   * The identity gate (ADR 0008). Omitted in production wiring, where
   * `createHandler` builds it from config and the runtime's profile directory;
   * supplied by tests that need to drive verification with a locally-generated
   * key set instead of the project's JWKS endpoint.
   */
  readonly auth?: AuthGate;
}
