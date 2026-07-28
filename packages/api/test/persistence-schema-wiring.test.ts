import { beforeEach, describe, expect, it, vi } from "vitest";
import { AFRIP_SCHEMA } from "@afrip/shared-kernel";
import { VILLAGES_TABLE } from "@afrip/village-registry";
import { DEFAULT_CLIENT_SCHEMA, createFakeSupabase } from "./fake-supabase-client.js";

/**
 * Closes the last gap in the schema story: SUPABASE_SCHEMA is read by
 * loadConfig and the adapters honour whatever they are handed, but nothing so
 * far proves the value actually travels from the environment to the adapters.
 * `createSupabaseRuntime` builds its own client via `createClient`, so that one
 * link can only be observed by standing in for the Supabase module.
 *
 * The mock is hoisted file-wide, which is why this lives apart from
 * persistence.test.ts — those tests exercise the real module with an injected
 * client and must not see a stub.
 */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./fake-supabase-client.js").createFakeSupabase> | null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => fake.current?.client),
}));

// Imported after the mock is registered so persistence.ts binds to the stub.
const { loadConfig } = await import("../src/config.js");
const { createPersistence } = await import("../src/persistence.js");

function runtimeFor(env: Record<string, string | undefined>) {
  const config = loadConfig({
    PERSISTENCE: "supabase",
    SUPABASE_URL: "https://fake.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
    ...env,
  });
  if (!config.ok) throw new Error(`expected a valid config, got: ${config.error}`);
  return createPersistence(config.value);
}

describe("SUPABASE_SCHEMA reaches the adapters", () => {
  beforeEach(() => {
    fake.current = createFakeSupabase();
  });

  it("sends queries to assam_floods when SUPABASE_SCHEMA is unset", async () => {
    const runtime = runtimeFor({});

    await runtime.platform.villageRegistry.getVillageProfile.execute({ villageId: "village-1" });

    expect(fake.current?.tablesTouched()).toContain(VILLAGES_TABLE);
    expect(fake.current?.schemasUsed()).toEqual([AFRIP_SCHEMA]);
    expect(fake.current?.schemasUsed()).not.toContain(DEFAULT_CLIENT_SCHEMA);
  });

  it("sends queries to the overriding schema when SUPABASE_SCHEMA is set", async () => {
    const runtime = runtimeFor({ SUPABASE_SCHEMA: "assam_floods_review" });

    await runtime.platform.villageRegistry.getVillageProfile.execute({ villageId: "village-1" });
    await runtime.checkReady();

    expect(fake.current?.schemasUsed()).toEqual(["assam_floods_review"]);
  });

  // The dangerous override is the one that looks harmless: an operator setting
  // SUPABASE_SCHEMA=public would point AFRIP at another application's tables.
  // Config does not forbid it, but nothing should ever arrive there by default.
  it("never falls back to public when the variable is blank", async () => {
    const runtime = runtimeFor({ SUPABASE_SCHEMA: "   " });

    await runtime.platform.villageRegistry.getVillageProfile.execute({ villageId: "village-1" });

    expect(fake.current?.schemasUsed()).toEqual([AFRIP_SCHEMA]);
  });
});
