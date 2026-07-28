import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createPlatform, type Platform, type PlatformOverrides } from "@afrip/platform";
import { AFRIP_SCHEMA, err, ok, type Result } from "@afrip/shared-kernel";
import { SupabaseVillageRepository, VILLAGES_TABLE } from "@afrip/village-registry";
import { SupabaseAssignmentRepository, SupabaseNgoRepository } from "@afrip/ngo-coordination";
import { SupabaseRecoveryIndexRepository } from "@afrip/recovery-intelligence";
import { SupabaseIssueRepository } from "@afrip/issue-tracking";
import { SupabaseBeneficiaryRepository } from "@afrip/beneficiary-registry";
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
 * The table `GET /ready` probes. Villages are the root of every other context's
 * foreign keys, so a readable villages table is the cheapest honest evidence
 * that the schema is migrated and this key can actually read through RLS.
 */
export const READY_PROBE_TABLE = VILLAGES_TABLE;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the Supabase-backed runtime around an already-constructed client.
 *
 * Split out from `createSupabaseRuntime` so tests can drive the whole wiring
 * with a stubbed client: no network, no live database, no service-role key.
 */
export function createSupabaseRuntimeFromClient(
  client: SupabaseClient,
  overrides: PlatformOverrides = {},
  schema: string = AFRIP_SCHEMA,
): PlatformRuntime {
  const platform = createPlatform({
    ...overrides,
    repositories: {
      village: new SupabaseVillageRepository(client, schema),
      ngo: new SupabaseNgoRepository(client, schema),
      assignment: new SupabaseAssignmentRepository(client, schema),
      recoveryIndex: new SupabaseRecoveryIndexRepository(client, schema),
      issue: new SupabaseIssueRepository(client, schema),
      beneficiary: new SupabaseBeneficiaryRepository(client, schema),
      // An explicit per-context override still wins, so a test or a future
      // hybrid deployment can keep one context in memory.
      ...overrides.repositories,
    },
  });

  return {
    mode: "supabase",
    platform,
    beneficiaryDirectory: new BeneficiaryDirectory(platform.bus),
    // A real round trip: an unreachable host, a bad key or an unmigrated schema
    // all surface here as a not-ready Result. It probes the SAME schema the
    // adapters write to, so a project missing `assam_floods` (or not exposing
    // it to PostgREST) fails readiness instead of passing on `public` and then
    // failing on the first real write. Readiness reports, it never throws — a
    // probe that 500s tells the operator nothing.
    checkReady: async (): Promise<Result<{ mode: PersistenceMode }>> => {
      try {
        const result = await client.schema(schema).from(READY_PROBE_TABLE).select("id").limit(1);
        if (result.error) {
          return err(`supabase unreachable: ${result.error.message}`);
        }
        return ok({ mode: "supabase" as const });
      } catch (error) {
        return err(`supabase unreachable: ${reason(error)}`);
      }
    },
  };
}

/**
 * Supabase-backed persistence (ADR 0004). The six context adapters are handed to
 * the composition root through its repository seam, so nothing below the HTTP
 * layer knows which storage technology is in play — the router, the routes and
 * their tests are identical in both modes.
 */
export function createSupabaseRuntime(
  config: ApiConfig,
  overrides: PlatformOverrides = {},
): PlatformRuntime {
  const url = config.supabaseUrl;
  const key = config.supabaseServiceRoleKey;
  if (url === null || key === null) {
    // loadConfig already rejects this combination; belt and braces for callers
    // that build an ApiConfig by hand.
    throw new Error(
      "supabase persistence requires both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }

  // Server-side service-role client: there is no browser and no user session to
  // persist, and leaving session persistence on would have the client try to
  // write tokens to a storage that does not exist.
  const client = createClient(url, key, { auth: { persistSession: false } });

  // config.supabaseSchema always holds a value (SUPABASE_SCHEMA or the default),
  // so the adapters are never left on the client's `public` default.
  return createSupabaseRuntimeFromClient(client, overrides, config.supabaseSchema);
}

export function createPersistence(config: ApiConfig, overrides: PlatformOverrides = {}): PlatformRuntime {
  return config.persistence === "supabase"
    ? createSupabaseRuntime(config, overrides)
    : createMemoryRuntime(overrides);
}
