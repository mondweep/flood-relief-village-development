import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  DEFAULT_AUTH_PROVIDERS,
  DEFAULT_PORT,
  DEFAULT_SUPABASE_SCHEMA,
  loadConfig,
} from "../src/config.js";
import { createPersistence, createSupabaseRuntime } from "../src/persistence.js";
import { testConfig } from "./helpers.js";

describe("loadConfig", () => {
  it("defaults to port 8080, memory persistence and no token", () => {
    const result = loadConfig({});

    expect(result).toEqual({
      ok: true,
      value: {
        port: DEFAULT_PORT,
        apiToken: null,
        persistence: "memory",
        supabaseUrl: null,
        supabaseServiceRoleKey: null,
        supabasePublishableKey: null,
        supabaseJwtSecret: null,
        authJwt: false,
        authProviders: DEFAULT_AUTH_PROVIDERS,
        supabaseSchema: DEFAULT_SUPABASE_SCHEMA,
        version: API_VERSION,
        // Absent unless the deploy script stamped it.
        build: null,
      },
    });
  });

  describe("the git stamp", () => {
    const STAMP = {
      GIT_BRANCH: "main",
      GIT_COMMIT: "abc1234",
      GIT_REPOSITORY: "https://github.com/mondweep/flood-relief-village-development",
    };

    it("reads the branch, commit and repository the deploy script stamped", () => {
      const result = loadConfig(STAMP);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.build).toEqual({
          branch: "main",
          commit: "abc1234",
          repository: "https://github.com/mondweep/flood-relief-village-development",
        });
      }
    });

    /**
     * All three or nothing. A partial stamp would render a footer link that
     * points somewhere plausible and wrong — "serving branch main" on a build
     * from elsewhere — and a confident false provenance is worse than none,
     * because nothing about it looks broken.
     */
    it.each(["GIT_BRANCH", "GIT_COMMIT", "GIT_REPOSITORY"])(
      "reports no build at all when %s is missing",
      (missing) => {
        const partial: Record<string, string> = { ...STAMP };
        delete partial[missing];
        const result = loadConfig(partial);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.build).toBeNull();
      },
    );

    it("treats a blank stamp as no stamp", () => {
      const result = loadConfig({ ...STAMP, GIT_BRANCH: "   " });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.build).toBeNull();
    });
  });

  it("reads PORT and API_TOKEN", () => {
    const result = loadConfig({ PORT: "8099", API_TOKEN: "  token  " });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.port).toBe(8099);
    expect(result.value.apiToken).toBe("token");
  });

  it("rejects a non-numeric PORT", () => {
    expect(loadConfig({ PORT: "eighty-eighty" })).toEqual({
      ok: false,
      error: "PORT must be an integer between 0 and 65535, got: eighty-eighty",
    });
  });

  it("rejects an unknown PERSISTENCE mode", () => {
    expect(loadConfig({ PERSISTENCE: "postgres" })).toEqual({
      ok: false,
      error: 'PERSISTENCE must be "memory" or "supabase", got: postgres',
    });
  });

  it("fails fast when supabase persistence is selected without credentials", () => {
    expect(loadConfig({ PERSISTENCE: "supabase" })).toEqual({
      ok: false,
      error: "PERSISTENCE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set",
    });

    expect(loadConfig({ PERSISTENCE: "supabase", SUPABASE_URL: "https://x.supabase.co" })).toEqual({
      ok: false,
      error: "PERSISTENCE=supabase requires SUPABASE_SERVICE_ROLE_KEY to be set",
    });
  });

  it("accepts supabase persistence when both credentials are present", () => {
    const result = loadConfig({
      PERSISTENCE: "supabase",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.persistence).toBe("supabase");
  });
});

describe("Supabase Auth configuration (ADR 0008)", () => {
  it("turns JWT verification on as soon as SUPABASE_URL is configured", () => {
    const result = loadConfig({ SUPABASE_URL: "https://x.supabase.co" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authJwt).toBe(true);
  });

  it("leaves it off when there is nothing to verify against", () => {
    const result = loadConfig({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authJwt).toBe(false);
  });

  it("lets an operator force it off for a legacy-token-only revision", () => {
    const result = loadConfig({ SUPABASE_URL: "https://x.supabase.co", AUTH_JWT: "off" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authJwt).toBe(false);
  });

  // The failure this prevents is a server that boots happily and then 401s
  // every single request, with nothing in the logs to say why.
  it("refuses to boot with auth on and no SUPABASE_URL to verify against", () => {
    const secretOnly = loadConfig({ SUPABASE_JWT_SECRET: "shared-secret" });
    expect(secretOnly.ok).toBe(false);
    if (secretOnly.ok) return;
    expect(secretOnly.error).toContain("SUPABASE_URL");

    const forcedOn = loadConfig({ AUTH_JWT: "on" });
    expect(forcedOn.ok).toBe(false);
  });

  it("rejects an AUTH_JWT value that is neither on nor off", () => {
    expect(loadConfig({ AUTH_JWT: "maybe" })).toEqual({
      ok: false,
      error: 'AUTH_JWT must be a boolean ("on"/"off"), got: maybe',
    });
  });

  it("reads the optional HS256 fallback secret", () => {
    const result = loadConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_JWT_SECRET: " s3 " });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supabaseJwtSecret).toBe("s3");
  });

  it("reads the publishable key, and accepts the older SUPABASE_ANON_KEY spelling", () => {
    const publishable = loadConfig({ SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" });
    expect(publishable.ok).toBe(true);
    if (!publishable.ok) return;
    expect(publishable.value.supabasePublishableKey).toBe("sb_publishable_x");

    const anon = loadConfig({ SUPABASE_ANON_KEY: "anon-key" });
    expect(anon.ok).toBe(true);
    if (!anon.ok) return;
    expect(anon.value.supabasePublishableKey).toBe("anon-key");
  });

  // ADR 0008: "the design should not hard-code Google anywhere except that list".
  it("defaults the provider list to google and takes an override", () => {
    const defaulted = loadConfig({});
    expect(defaulted.ok).toBe(true);
    if (!defaulted.ok) return;
    expect(defaulted.value.authProviders).toEqual(["google"]);

    const overridden = loadConfig({ AUTH_PROVIDERS: "google, azure " });
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    expect(overridden.value.authProviders).toEqual(["google", "azure"]);
  });
});

describe("SUPABASE_SCHEMA", () => {
  // The default is the whole point: this Supabase project is shared, and
  // `public` holds other applications' tables. An unset SUPABASE_SCHEMA must
  // land on the AFRIP schema, never on the client's `public` default.
  it("defaults to assam_floods when unset", () => {
    const result = loadConfig({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supabaseSchema).toBe("assam_floods");
    expect(result.value.supabaseSchema).toBe(DEFAULT_SUPABASE_SCHEMA);
    expect(result.value.supabaseSchema).not.toBe("public");
  });

  it("defaults to assam_floods in supabase mode too", () => {
    const result = loadConfig({
      PERSISTENCE: "supabase",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supabaseSchema).toBe("assam_floods");
  });

  it("reads an explicit override", () => {
    const result = loadConfig({ SUPABASE_SCHEMA: "assam_floods_review" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supabaseSchema).toBe("assam_floods_review");
  });

  it("trims surrounding whitespace", () => {
    const result = loadConfig({ SUPABASE_SCHEMA: "  staging_schema  " });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supabaseSchema).toBe("staging_schema");
  });

  // An empty or whitespace-only value is an unset value, not an instruction to
  // fall back to `public`.
  it("treats a blank value as unset and keeps the default", () => {
    for (const blank of ["", "   "]) {
      const result = loadConfig({ SUPABASE_SCHEMA: blank });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.supabaseSchema).toBe(DEFAULT_SUPABASE_SCHEMA);
    }
  });
});

describe("persistence seam", () => {
  it("wires the in-memory platform for memory mode", async () => {
    const runtime = createPersistence(testConfig());

    expect(runtime.mode).toBe("memory");
    expect(await runtime.checkReady()).toEqual({ ok: true, value: { mode: "memory" } });
  });

  it("wires the supabase platform for supabase mode", () => {
    const config = testConfig({
      persistence: "supabase",
      supabaseUrl: "https://x.supabase.co",
      supabaseServiceRoleKey: "service-role-key",
    });

    // Constructing the runtime opens no connection: the Supabase client is lazy,
    // so this stays a pure wiring assertion with no network.
    expect(createSupabaseRuntime(config).mode).toBe("supabase");
    expect(createPersistence(config).mode).toBe("supabase");
  });

  it("refuses supabase mode without credentials rather than booting half-configured", () => {
    const config = testConfig({ persistence: "supabase" });

    expect(() => createSupabaseRuntime(config)).toThrow(
      /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});
