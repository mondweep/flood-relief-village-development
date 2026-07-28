import { describe, expect, it } from "vitest";
import { API_VERSION, DEFAULT_PORT, loadConfig } from "../src/config.js";
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
        version: API_VERSION,
      },
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
