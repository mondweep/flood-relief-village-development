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

/**
 * OAuth providers offered on the sign-in surface (ADR 0008). A list, not a
 * `googleEnabled` flag: the ADR is explicit that "Google" must not be hard-coded
 * anywhere except one provider list, so adding Microsoft or GitHub later is an
 * environment change rather than a code change.
 */
export const DEFAULT_AUTH_PROVIDERS: readonly string[] = ["google"];

/** Which git revision produced this build. Disclosed on `GET /health`. */
export interface BuildInfo {
  readonly branch: string;
  /** Short SHA. */
  readonly commit: string;
  readonly repository: string;
}

export interface ApiConfig {
  readonly port: number;
  /**
   * LEGACY shared bearer token (ADR 0008 transitional path). Accepted alongside
   * Supabase JWTs while the migration is in flight; null once it is retired.
   * Its presence is disclosed on `GET /health` — see routes/health.ts.
   */
  readonly apiToken: string | null;
  readonly persistence: PersistenceMode;
  readonly supabaseUrl: string | null;
  readonly supabaseServiceRoleKey: string | null;
  /**
   * Publishable (anon) key handed to the browser by `GET /public/config` so the
   * page can talk to GoTrue directly. NEVER the service-role key.
   */
  readonly supabasePublishableKey: string | null;
  /**
   * Legacy HS256 signing secret, used only when the project's JWKS endpoint is
   * unavailable. Optional: projects on asymmetric keys never need it.
   */
  readonly supabaseJwtSecret: string | null;
  /**
   * Whether the API verifies Supabase-issued JWTs. Defaults on as soon as
   * SUPABASE_URL (or SUPABASE_JWT_SECRET) is configured; `AUTH_JWT=off` forces
   * it back off for a revision that must run on the legacy token alone.
   */
  readonly authJwt: boolean;
  readonly authProviders: readonly string[];
  /** Postgres schema the adapters target. Never null — see DEFAULT_SUPABASE_SCHEMA. */
  readonly supabaseSchema: string;
  readonly version: string;
  /**
   * The source revision this build came from, stamped by the deploy script from
   * git. Null when it was not stamped — a local `npm run dev`, or a build that
   * bypassed the script — and reported as null rather than guessed, because a
   * fabricated branch name is worse than an absent one.
   */
  readonly build: BuildInfo | null;
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

function parseBoolean(raw: string | null, fallback: boolean, name: string): Result<boolean> {
  if (raw === null) return ok(fallback);
  const value = raw.toLowerCase();
  if (["1", "true", "on", "yes", "enabled"].includes(value)) return ok(true);
  if (["0", "false", "off", "no", "disabled"].includes(value)) return ok(false);
  return err(`${name} must be a boolean ("on"/"off"), got: ${raw}`);
}

function parseProviders(raw: string | null): readonly string[] {
  if (raw === null) return DEFAULT_AUTH_PROVIDERS;
  const providers = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  // An explicitly empty list is a deliberate "no OAuth here", not a typo that
  // should silently restore the default.
  return providers;
}

/**
 * Reads and validates the process environment. Fails fast (as an err Result the
 * entry point turns into a non-zero exit) rather than booting a half-configured
 * server — a Cloud Run revision that starts but cannot reach its datastore is
 * worse than one that never starts.
 */
/**
 * Reads the deploy-time git stamp. All three parts or nothing: a branch with no
 * commit, or a commit with no repository, produces a footer link that points
 * somewhere plausible and wrong, which is the failure this is meant to prevent.
 */
function buildInfoFrom(env: Env): BuildInfo | null {
  const branch = trimmed(env["GIT_BRANCH"]);
  const commit = trimmed(env["GIT_COMMIT"]);
  const repository = trimmed(env["GIT_REPOSITORY"]);
  if (branch === null || commit === null || repository === null) return null;
  return { branch, commit, repository };
}

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

  const supabaseJwtSecret = trimmed(env["SUPABASE_JWT_SECRET"]);

  // Auth is on by default the moment there is anything to verify against. An
  // operator who wants it off says so out loud rather than achieving it by
  // omitting a variable and never noticing.
  const authJwtResult = parseBoolean(
    trimmed(env["AUTH_JWT"]),
    supabaseUrl !== null || supabaseJwtSecret !== null,
    "AUTH_JWT",
  );
  if (!authJwtResult.ok) return err(authJwtResult.error);

  // Fail fast rather than boot a server whose auth gate can never succeed: both
  // the JWKS endpoint and the expected `iss` are derived from SUPABASE_URL, so
  // without it every single token would 401 and the cause would be invisible.
  if (authJwtResult.value && supabaseUrl === null) {
    return err(
      "JWT verification is enabled but SUPABASE_URL is not set — the JWKS endpoint " +
        "and the expected issuer are both derived from it. Set SUPABASE_URL, or set " +
        "AUTH_JWT=off to run on the legacy API_TOKEN alone.",
    );
  }

  return ok({
    port: portResult.value,
    apiToken: trimmed(env["API_TOKEN"]),
    persistence: persistenceResult.value,
    supabaseUrl,
    supabaseServiceRoleKey,
    supabasePublishableKey:
      trimmed(env["SUPABASE_PUBLISHABLE_KEY"]) ?? trimmed(env["SUPABASE_ANON_KEY"]),
    supabaseJwtSecret,
    authJwt: authJwtResult.value,
    authProviders: parseProviders(trimmed(env["AUTH_PROVIDERS"])),
    supabaseSchema: trimmed(env["SUPABASE_SCHEMA"]) ?? DEFAULT_SUPABASE_SCHEMA,
    version: API_VERSION,
    build: buildInfoFrom(env),
  });
}
