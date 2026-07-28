import type { ApiConfig } from "../config.js";
import type { PlatformRuntime } from "../persistence.js";

/** Everything a route module is allowed to reach for. */
export interface RouteDeps {
  readonly config: ApiConfig;
  readonly runtime: PlatformRuntime;
}
