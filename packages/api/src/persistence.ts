import { createPlatform, type Platform, type PlatformOverrides } from "@afrip/platform";
import { ok, type Result } from "@afrip/shared-kernel";
import type { ApiConfig, PersistenceMode } from "./config.js";
import { BeneficiaryDirectory } from "./projections.js";

/**
 * Everything the HTTP layer needs from the storage tier: the wired use cases,
 * the API-owned read models bound to that same platform's event bus, and a
 * liveness probe for `GET /ready`.
 */
export interface PlatformRuntime {
  readonly mode: PersistenceMode;
  readonly platform: Platform;
  readonly beneficiaryDirectory: BeneficiaryDirectory;
  /** Resolves ok when the datastore is reachable; err with a reason otherwise. */
  checkReady(): Promise<Result<{ mode: PersistenceMode }>>;
}

export function createMemoryRuntime(overrides: PlatformOverrides = {}): PlatformRuntime {
  const platform = createPlatform(overrides);
  return {
    mode: "memory",
    platform,
    beneficiaryDirectory: new BeneficiaryDirectory(platform.bus),
    // In-memory adapters live inside this process: if the server answers at all,
    // the datastore is reachable.
    checkReady: async () => ok({ mode: "memory" as const }),
  };
}

/**
 * SEAM — Supabase-backed persistence.
 *
 * A separate workstream is adding Supabase repository adapters to each bounded
 * context. When they land, this factory is the single place that changes: it
 * should build a Supabase client from `config.supabaseUrl` /
 * `config.supabaseServiceRoleKey`, pass the context adapters into an extended
 * `createPlatform()` override set, and implement `checkReady()` as a cheap
 * round-trip (e.g. `select 1` against a known table).
 *
 * Nothing above this line imports a Supabase adapter, so the seam can be filled
 * in without touching the router, the routes or the tests.
 *
 * TODO(persistence): wire the Supabase repository adapters here.
 */
export function createSupabaseRuntime(config: ApiConfig): PlatformRuntime {
  void config;
  throw new Error("supabase persistence not yet wired");
}

export function createPersistence(config: ApiConfig, overrides: PlatformOverrides = {}): PlatformRuntime {
  return config.persistence === "supabase" ? createSupabaseRuntime(config) : createMemoryRuntime(overrides);
}
