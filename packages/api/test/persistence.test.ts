import { describe, expect, it } from "vitest";
import { FixedClock } from "@afrip/shared-kernel";
import { VILLAGES_TABLE } from "@afrip/village-registry";
import { ASSIGNMENTS_TABLE, NGOS_TABLE } from "@afrip/ngo-coordination";
import { INDICES_TABLE } from "@afrip/recovery-intelligence";
import { ISSUES_TABLE } from "@afrip/issue-tracking";
import { BENEFICIARIES_TABLE } from "@afrip/beneficiary-registry";
import {
  READY_PROBE_TABLE,
  createMemoryRuntime,
  createPersistence,
  createSupabaseRuntimeFromClient,
} from "../src/persistence.js";
import { createFakeSupabase, type FakeSupabase } from "./fake-supabase-client.js";
import { startTestServerWith, testConfig, type TestServer } from "./helpers.js";

const clock = (): FixedClock => new FixedClock(new Date("2026-07-01T00:00:00.000Z"));

describe("persistence mode selection", () => {
  it("builds an in-memory runtime by default", () => {
    const runtime = createPersistence(testConfig());
    expect(runtime.mode).toBe("memory");
  });

  it("no longer refuses to build a supabase runtime", () => {
    expect(() =>
      createPersistence(
        testConfig({
          persistence: "supabase",
          supabaseUrl: "https://fake.supabase.co",
          supabaseServiceRoleKey: "fake-service-role-key",
        }),
      ),
    ).not.toThrow();
  });

  it("reports mode supabase, which is what GET /health surfaces", () => {
    const runtime = createPersistence(
      testConfig({
        persistence: "supabase",
        supabaseUrl: "https://fake.supabase.co",
        supabaseServiceRoleKey: "fake-service-role-key",
      }),
    );
    expect(runtime.mode).toBe("supabase");
  });

  it("refuses to build a supabase runtime without credentials", () => {
    expect(() => createPersistence(testConfig({ persistence: "supabase" }))).toThrow(
      /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

describe("supabase runtime — the Supabase adapters are the ones wired in", () => {
  it("reads villages through Supabase, not an in-memory map", async () => {
    const fake = createFakeSupabase();
    const runtime = createSupabaseRuntimeFromClient(fake.client, { clock: clock() });

    await runtime.platform.villageRegistry.getVillageProfile.execute({ villageId: "village-1" });

    expect(fake.tablesTouched()).toContain(VILLAGES_TABLE);
  });

  it("writes NGOs through Supabase", async () => {
    const fake = createFakeSupabase();
    const runtime = createSupabaseRuntimeFromClient(fake.client, { clock: clock() });

    await runtime.platform.ngoCoordination.registerNgo.execute({
      name: "Sewa Trust",
      focusAreas: ["water"],
      capacity: 3,
    });

    expect(fake.queriesTo(NGOS_TABLE).map((q) => q.operation)).toContain("upsert");
  });

  it("reads assignments through Supabase", async () => {
    const fake = createFakeSupabase();
    const runtime = createSupabaseRuntimeFromClient(fake.client, { clock: clock() });

    await runtime.platform.ngoCoordination.listUnassignedVillages.execute([
      { villageId: "village-1", severity: "critical" },
    ]);

    expect(fake.tablesTouched()).toContain(ASSIGNMENTS_TABLE);
  });

  it("reads recovery indices through Supabase", async () => {
    const fake = createFakeSupabase();
    const runtime = createSupabaseRuntimeFromClient(fake.client, { clock: clock() });

    await runtime.platform.recoveryIntelligence.getRecoveryIndex.execute({
      villageId: "village-1",
    });

    expect(fake.tablesTouched()).toContain(INDICES_TABLE);
  });

  it("reads issues through Supabase", async () => {
    const fake = createFakeSupabase();
    const runtime = createSupabaseRuntimeFromClient(fake.client, { clock: clock() });

    await runtime.platform.issueTracking.routeIssue.execute({ issueId: "issue-1" });

    expect(fake.tablesTouched()).toContain(ISSUES_TABLE);
  });

  it("reads beneficiaries through Supabase", async () => {
    const fake = createFakeSupabase();
    const runtime = createSupabaseRuntimeFromClient(fake.client, { clock: clock() });

    await runtime.platform.beneficiaryRegistry.listOverdueFollowUps.execute();

    expect(fake.tablesTouched()).toContain(BENEFICIARIES_TABLE);
  });

  it("keeps the API-owned read model bound to this platform's bus", async () => {
    const fake = createFakeSupabase();
    const runtime = createSupabaseRuntimeFromClient(fake.client, { clock: clock() });

    expect(runtime.beneficiaryDirectory).toBeDefined();
    expect(runtime.platform.bus).not.toBe(createMemoryRuntime().platform.bus);
  });

  it("lets an explicit repository override win over the Supabase default", async () => {
    const fake = createFakeSupabase();
    const runtime = createSupabaseRuntimeFromClient(fake.client, {
      clock: clock(),
      repositories: {
        village: {
          findById: async () => null,
          save: async () => undefined,
          listAll: async () => [],
        },
      },
    });

    await runtime.platform.villageRegistry.getVillageProfile.execute({ villageId: "village-1" });

    expect(fake.tablesTouched()).not.toContain(VILLAGES_TABLE);
  });
});

describe("supabase readiness probe", () => {
  it("is a real round trip: a bounded select against a known table", async () => {
    const fake = createFakeSupabase();
    const runtime = createSupabaseRuntimeFromClient(fake.client);

    const result = await runtime.checkReady();

    expect(result).toEqual({ ok: true, value: { mode: "supabase" } });
    const probe = fake.queriesTo(READY_PROBE_TABLE)[0];
    expect(probe?.operation).toBe("select");
    expect(probe?.columns).toBe("id");
    expect(probe?.limit).toBe(1);
  });

  it("reports not-ready — rather than throwing — when the query errors", async () => {
    const fake = createFakeSupabase({
      failOn: { table: READY_PROBE_TABLE, message: "relation does not exist" },
    });

    const result = await createSupabaseRuntimeFromClient(fake.client).checkReady();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/relation does not exist/);
  });

  it("reports not-ready — rather than throwing — when the host is unreachable", async () => {
    const fake = createFakeSupabase({
      throwOn: { table: READY_PROBE_TABLE, message: "getaddrinfo ENOTFOUND fake.supabase.co" },
    });

    const result = await createSupabaseRuntimeFromClient(fake.client).checkReady();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/ENOTFOUND/);
  });

  it("never touches the datastore in memory mode", async () => {
    const result = await createMemoryRuntime().checkReady();
    expect(result).toEqual({ ok: true, value: { mode: "memory" } });
  });
});

describe("supabase mode over real HTTP", () => {
  async function boot(fake: FakeSupabase): Promise<TestServer> {
    return startTestServerWith({
      config: testConfig({
        persistence: "supabase",
        supabaseUrl: "https://fake.supabase.co",
        supabaseServiceRoleKey: "fake-service-role-key",
      }),
      runtime: createSupabaseRuntimeFromClient(fake.client, { clock: clock() }),
    });
  }

  it("reports persistence supabase on GET /health", async () => {
    const server = await boot(createFakeSupabase());
    try {
      const response = await server.request("/health");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: "ok", persistence: "supabase" });
    } finally {
      await server.close();
    }
  });

  it("reports ready on GET /ready when the probe succeeds", async () => {
    const server = await boot(createFakeSupabase());
    try {
      const response = await server.request("/ready");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: "ready", persistence: "supabase" });
    } finally {
      await server.close();
    }
  });

  it("answers 503 on GET /ready when the datastore is unreachable", async () => {
    const server = await boot(
      createFakeSupabase({ throwOn: { table: READY_PROBE_TABLE, message: "fetch failed" } }),
    );
    try {
      const response = await server.request("/ready");
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ status: "unavailable", persistence: "supabase" });
    } finally {
      await server.close();
    }
  });
});
