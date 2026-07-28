import { AFRIP_SCHEMA, err, ok, type Result } from "@afrip/shared-kernel";

/**
 * Reported by GET /health. Kept as a literal rather than read from package.json
 * so the esbuild bundle stays a single self-contained file.
 */
export const API_VERSION = "0.1.0";

export const DEFAULT_PORT = 8080;

/**
 * Postgres schema the AFRIP tables live in. NOT `public`: the Supabase project
 * is shared with other applications that own `public`, so a client left on its
 * default schema would read and write in someone else's namespace. Overridable
 * (a review branch or a second environment may use another schema) but it
 * always resolves to a value — there is no "unset" that falls back to `public`.
 */
export const DEFAULT_SUPABASE_SCHEMA = AFRIP_SCHEMA;

export type PersistenceMode = "memory" | "supabase";

export interface ApiConfig {
  readonly port: number;
  /** Bearer token required on non-public routes; null disables authentication. */
  readonly apiToken: string | null;
  readonly persistence: PersistenceMode;
  readonly supabaseUrl: string | null;
  readonly supabaseServiceRoleKey: string | null;
  /** Postgres schema the adapters target. Never null — see DEFAULT_SUPABASE_SCHEMA. */
  readonly supabaseSchema: string;
  readonly version: string;
}

export type Env = Record<string, string | undefined>;

function trimmed(value: string | undefined): string | null {
  if (value === undefined) return null;
  const cleaned = value.trim();
  return cleaned.length === 0 ? null : cleaned;
}

function parsePort(raw: string | null): Result<number> {
  if (raw === null) return ok(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return err(`PORT must be an integer between 0 and 65535, got: ${raw}`);
  }
  return ok(port);
}

function parsePersistence(raw: string | null): Result<PersistenceMode> {
  if (raw === null) return ok("memory");
  const mode = raw.toLowerCase();
  if (mode !== "memory" && mode !== "supabase") {
    return err(`PERSISTENCE must be "memory" or "supabase", got: ${raw}`);
  }
  return ok(mode);
}

/**
 * Reads and validates the process environment. Fails fast (as an err Result the
 * entry point turns into a non-zero exit) rather than booting a half-configured
 * server — a Cloud Run revision that starts but cannot reach its datastore is
 * worse than one that never starts.
 */
export function loadConfig(env: Env = process.env): Result<ApiConfig> {
  const portResult = parsePort(trimmed(env["PORT"]));
  if (!portResult.ok) return err(portResult.error);

  const persistenceResult = parsePersistence(trimmed(env["PERSISTENCE"]));
  if (!persistenceResult.ok) return err(persistenceResult.error);

  const supabaseUrl = trimmed(env["SUPABASE_URL"]);
  const supabaseServiceRoleKey = trimmed(env["SUPABASE_SERVICE_ROLE_KEY"]);

  if (persistenceResult.value === "supabase") {
    const missing: string[] = [];
    if (supabaseUrl === null) missing.push("SUPABASE_URL");
    if (supabaseServiceRoleKey === null) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (missing.length > 0) {
      return err(`PERSISTENCE=supabase requires ${missing.join(" and ")} to be set`);
    }
  }

  return ok({
    port: portResult.value,
    apiToken: trimmed(env["API_TOKEN"]),
    persistence: persistenceResult.value,
    supabaseUrl,
    supabaseServiceRoleKey,
    supabaseSchema: trimmed(env["SUPABASE_SCHEMA"]) ?? DEFAULT_SUPABASE_SCHEMA,
    version: API_VERSION,
  });
}
