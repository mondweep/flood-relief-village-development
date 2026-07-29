import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Platform, PlatformOverrides } from "@afrip/platform";
import { AFRIP_SCHEMA, err, ok, type Result } from "@afrip/shared-kernel";
import { SupabaseVillageRepository, VILLAGES_TABLE } from "@afrip/village-registry";
import { SupabaseAssignmentRepository, SupabaseNgoRepository } from "@afrip/ngo-coordination";
import { SupabaseRecoveryIndexRepository } from "@afrip/recovery-intelligence";
import { SupabaseIssueRepository } from "@afrip/issue-tracking";
import { SupabaseBeneficiaryRepository } from "@afrip/beneficiary-registry";
import type { ProfileDirectory } from "./auth.js";
import type { ApiConfig, PersistenceMode } from "./config.js";
import { SupabaseProfileDirectory } from "./profiles.js";
import { BeneficiaryDirectory } from "./projections.js";
import { createBasePlatform } from "./request-platform.js";

/**
 * The bounded contexts the composition root wires for which NO Supabase adapter
 * exists yet — only an in-memory one. Their tables are already in
 * `supabase/migrations/00001_initial_schema.sql`, so writing the adapters is
 * additive work; until someone does, `PERSISTENCE=supabase` genuinely means
 * "supabase for six contexts, process memory for these four".
 *
 * Each entry lists the `PlatformRepositories` ports the context owns, so an
 * operator who injects durable adapters by hand drops off this list instead of
 * being warned about a problem they have already solved.
 */
export const CONTEXTS_WITHOUT_SUPABASE_ADAPTER: ReadonlyArray<{
  readonly context: string;
  readonly ports: readonly (keyof NonNullable<PlatformOverrides["repositories"]>)[];
}> = [
  { context: "fund-monitoring", ports: ["project"] },
  { context: "volunteer-management", ports: ["volunteer"] },
  { context: "development-planning", ports: ["plan"] },
  { context: "social-media-intelligence", ports: ["signal", "alert"] },
];

/**
 * What `GET /health` discloses when the runtime is only partly durable. Absent
 * from the payload when every wired context is backed by the reported mode.
 */
export interface PartialPersistence {
  /** Always false — the field exists only when something is NOT durable. */
  readonly durable: false;
  readonly memoryBackedContexts: readonly string[];
  readonly detail: string;
}

export const PARTIAL_PERSISTENCE_DETAIL =
  "no supabase adapter exists for these contexts yet; their data is held in process memory and is lost on restart";

/**
 * Everything the HTTP layer needs from the storage tier: the wired use cases,
 * the API-owned read models bound to that same platform's event bus, and a
 * liveness probe for `GET /ready`.
 */
export interface PlatformRuntime {
  readonly mode: PersistenceMode;
  /**
   * The LONG-LIVED platform: it owns the event bus, the cross-context
   * subscriptions and the repository adapters, and everything expensive is
   * built into it exactly once (ADR 0010).
   *
   * Route handlers must NOT use it. Anything published through it is attributed
   * to `system`, which is right for a scheduled sweep and wrong for an officer's
   * POST; per request, `app.ts` re-composes it around the caller's actor and
   * hands the result to the handler as `ctx.platform`.
   */
  readonly platform: Platform;
  readonly beneficiaryDirectory: BeneficiaryDirectory;
  /**
   * Contexts served from process memory DESPITE `mode` saying otherwise. Empty
   * in memory mode — there the mode already tells the whole truth, and calling
   * a wholly volatile runtime "partial" would understate it.
   */
  readonly memoryBackedContexts: readonly string[];
  /**
   * Where the auth gate resolves a verified JWT `sub` to an application profile
   * (ADR 0008). Absent in memory mode — there is no `user_profiles` table in a
   * process-memory runtime — and the gate falls back to a claims-only actor
   * pinned to the least-privileged role.
   */
  readonly profiles?: ProfileDirectory;
  /** Resolves ok when the datastore is reachable; err with a reason otherwise. */
  checkReady(): Promise<Result<{ mode: PersistenceMode }>>;
}

/** The `/health` disclosure for a runtime, or null when it has nothing to disclose. */
export function partialPersistenceOf(runtime: PlatformRuntime): PartialPersistence | null {
  if (runtime.memoryBackedContexts.length === 0) return null;
  return {
    durable: false,
    memoryBackedContexts: runtime.memoryBackedContexts,
    detail: PARTIAL_PERSISTENCE_DETAIL,
  };
}

export function createMemoryRuntime(overrides: PlatformOverrides = {}): PlatformRuntime {
  const platform = createBasePlatform(overrides);
  return {
    mode: "memory",
    platform,
    beneficiaryDirectory: new BeneficiaryDirectory(platform.bus),
    // `mode: "memory"` already says every context is volatile; repeating four of
    // them under a "partial" heading would imply the other six are durable.
    memoryBackedContexts: [],
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
  const platform = createBasePlatform({
    ...overrides,
    repositories: {
      village: new SupabaseVillageRepository(client, schema),
      ngo: new SupabaseNgoRepository(client, schema),
      assignment: new SupabaseAssignmentRepository(client, schema),
      recoveryIndex: new SupabaseRecoveryIndexRepository(client, schema),
      issue: new SupabaseIssueRepository(client, schema),
      beneficiary: new SupabaseBeneficiaryRepository(client, schema),
      // The remaining five ports (project, volunteer, plan, signal, alert) are
      // deliberately NOT listed: no Supabase adapter has been written for them,
      // so the composition root falls back to their in-memory adapters. That
      // fallback is disclosed on `/health` rather than left to be discovered by
      // an operator wondering where the volunteer hours went after a restart.
      //
      // An explicit per-context override still wins, so a test or a future
      // hybrid deployment can keep one context in memory — or supply the
      // missing durable adapter without touching this file.
      ...overrides.repositories,
    },
  });

  return {
    mode: "supabase",
    platform,
    beneficiaryDirectory: new BeneficiaryDirectory(platform.bus),
    // Same client, same schema as every other adapter: identities are stored
    // beside the data they govern, not in a second place that can drift.
    profiles: new SupabaseProfileDirectory(client, schema),
    // The honest half of the seam above: those four contexts got no Supabase
    // adapter, so this runtime is only partly durable and says so out loud on
    // `/health`. A context whose every port the caller overrode is left off —
    // they supplied their own adapter and we cannot claim it is volatile.
    memoryBackedContexts: CONTEXTS_WITHOUT_SUPABASE_ADAPTER.filter(
      (entry) => !entry.ports.every((port) => overrides.repositories?.[port] !== undefined),
    ).map((entry) => entry.context),
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
