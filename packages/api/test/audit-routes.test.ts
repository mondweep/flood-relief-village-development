import { SequentialIdGenerator } from "@afrip/shared-kernel";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthGate,
  createJwtVerifier,
  localKeySet,
  type ActorContext,
  type ProfileDirectory,
  type UserRole,
  type VerifiedClaims,
} from "../src/auth.js";
import { FORBIDDEN_CODE } from "../src/http-result.js";
import { createMemoryRuntime } from "../src/persistence.js";
import { buildRouter } from "../src/routes/index.js";
import { AUDIT_READER_ROLES } from "../src/routes/audit.js";
import { startTestServerWith, testConfig, type TestServer } from "./helpers.js";

/**
 * Audit reporting over HTTP (ADR 0011 §Reporting).
 *
 * The audit log holds whatever the events held, which for
 * `beneficiary.registered.v1` is a person's name. So the access tests here are
 * not ceremony: this endpoint is a cross-village index of everything that has
 * ever happened, and ADR 0011 restricts it to `admin` and `district_officer`.
 */

const SUPABASE_URL = "https://proj.supabase.co";
const KID = "afrip-audit-key";

const PEOPLE: Record<UserRole, ActorContext> = {
  admin: { id: "user-admin", email: "mondweep@dxsure.uk", role: "admin" },
  district_officer: { id: "user-officer", email: "officer@assam.gov.in", role: "district_officer" },
  ngo_coordinator: { id: "user-ngo", email: "coord@goonj.org", role: "ngo_coordinator" },
  village_committee: { id: "user-committee", email: "member@village.in", role: "village_committee" },
  citizen: { id: "user-citizen", email: "resident@example.org", role: "citizen" },
};

const keys = await generateKeyPair("RS256", { extractable: true });
const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
const KEY_SET = localKeySet({ keys: [jwk] });

async function tokenFor(role: UserRole): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: PEOPLE[role].email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setSubject(PEOPLE[role].id)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(keys.privateKey);
}

const profiles: ProfileDirectory = {
  resolve: async (claims: VerifiedClaims) =>
    Object.values(PEOPLE).find((person) => person.id === claims.sub) ?? null,
};

async function boot(): Promise<TestServer> {
  const config = testConfig({ authJwt: true, supabaseUrl: SUPABASE_URL });
  return startTestServerWith({
    config,
    runtime: createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) }),
    auth: createAuthGate({
      config,
      verifier: createJwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: null, keySet: KEY_SET }),
      profiles,
    }),
  });
}

const VILLAGE = {
  name: "Majuli",
  district: "Majuli",
  state: "Assam",
  geo: { lat: 26.95, lng: 94.17, source: "map_pin" },
  population: 900,
  households: 200,
  affectedFamilies: 120,
  severity: "severe",
};

describe("who may read the audit trail", () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  async function get(role: UserRole, path: string) {
    return server.request(path, { token: await tokenFor(role) });
  }

  it.each(AUDIT_READER_ROLES)("admits %s", async (role) => {
    server = await boot();
    const response = await get(role, "/audit");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it.each(["citizen", "ngo_coordinator", "village_committee"] as const)(
    "refuses %s with 403",
    async (role) => {
      server = await boot();
      const response = await get(role, "/audit");

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: FORBIDDEN_CODE });
      expect((response.body as { error: string }).error).toMatch(new RegExp(role));
    },
  );

  it("refuses an unauthenticated caller before the gate even reaches the handler", async () => {
    server = await boot();
    expect((await server.request("/audit")).status).toBe(401);
  });

  /**
   * THE STRUCTURAL GUARD, and the reason the exception to ADR 0009 in
   * `routes/audit.ts` is tolerable.
   *
   * The role check on these routes is a line of code in a handler rather than an
   * entry in the policy table, so a tenth audit route added later could simply
   * omit it and nothing would fail. This enumerates the routes from the ROUTER,
   * not from a list written here, so a new `/audit` path is covered the day it
   * is registered — and the test fails until someone gates it.
   */
  it("refuses a citizen on every registered /audit route, enumerated from the router", async () => {
    const runtime = createMemoryRuntime();
    const router = buildRouter({ config: testConfig(), runtime });
    // Reach into the router's own table rather than restating the paths.
    const paths = (router as unknown as { routes: { method: string; segments: string[] }[] }).routes
      .filter((route) => route.segments[0] === "audit")
      .map((route) => "/" + route.segments.map((s) => (s.startsWith(":") ? "x" : s)).join("/"));

    expect(paths.length).toBeGreaterThanOrEqual(3);

    server = await boot();
    for (const path of paths) {
      const response = await get("citizen", path);
      expect(response.status, `${path} did not refuse a citizen`).toBe(403);
    }
  });
});

describe("what the audit trail reports", () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  async function post(role: UserRole, path: string, body: unknown) {
    return server.request(path, {
      method: "POST",
      token: await tokenFor(role),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * The end-to-end property ADR 0011 exists for: an action taken through the API
   * is afterwards attributable to the person who took it, without any use case
   * having been told to record anything.
   */
  it("records who registered a village, from the request that did it", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);

    const response = await server.request("/audit", { token: await tokenFor("admin") });
    const entries = (response.body as { entries: { eventName: string; actorEmail: string }[] }).entries;

    const registered = entries.find((entry) => entry.eventName === "village.registered.v1");
    expect(registered, JSON.stringify(entries)).toBeDefined();
    expect(registered?.actorEmail).toBe(PEOPLE.district_officer.email);
  });

  it("answers 'everything that happened to this village'", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);
    await post("district_officer", "/villages/village-1/damage-assessments", {
      housesDamaged: 40,
      schoolsDamaged: 1,
      healthCentresDamaged: 0,
      waterSourcesDamaged: 3,
      agricultureHectaresLost: 22,
      livestockLost: 8,
    });

    const response = await server.request("/audit/subjects/village/village-1", {
      token: await tokenFor("district_officer"),
    });
    const entries = (
      response.body as { entries: { eventName: string; subjectId: string; actorRole: string | null }[] }
    ).entries;

    expect(response.status).toBe(200);
    expect(entries.map((e) => e.eventName).sort()).toEqual([
      // The cross-context reaction is here on purpose, and it is the interesting
      // part: recording a damage assessment causes Recovery Intelligence to
      // recalculate the index, and that recalculation IS something that happened
      // to this village. A district officer asking "what happened here?" should
      // see it. Nobody wrote code to audit it — it is audited because it is an
      // event, which is the whole argument of ADR 0011.
      "recovery.score-calculated.v1",
      "village.damage-assessed.v1",
      "village.registered.v1",
    ]);
    expect(entries.every((e) => e.subjectId === "village-1")).toBe(true);
  });

  /**
   * The platform's own reactions are attributed to the PLATFORM, not to whoever
   * happened to trigger them. ADR 0010 is explicit that `system` is a positive
   * claim — "no human did this" — and conflating it with the officer's action
   * would put a decision in their name that they did not make.
   */
  it("attributes a cross-context reaction to the platform, not to the officer", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);
    await post("district_officer", "/villages/village-1/damage-assessments", {
      housesDamaged: 40,
      schoolsDamaged: 1,
      healthCentresDamaged: 0,
      waterSourcesDamaged: 3,
      agricultureHectaresLost: 22,
      livestockLost: 8,
    });

    const response = await server.request("/audit/subjects/village/village-1", {
      token: await tokenFor("district_officer"),
    });
    const entries = (
      response.body as { entries: { eventName: string; actorRole: string | null; actorEmail: string | null }[] }
    ).entries;

    const reaction = entries.find((e) => e.eventName === "recovery.score-calculated.v1");
    const officerAction = entries.find((e) => e.eventName === "village.damage-assessed.v1");

    expect(reaction?.actorRole).toMatch(/^system:/);
    expect(reaction?.actorEmail).toBeNull();
    expect(officerAction?.actorEmail).toBe(PEOPLE.district_officer.email);
  });

  it("answers 'everything this account has done'", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);

    const response = await server.request(`/audit/actors/${PEOPLE.district_officer.id}`, {
      token: await tokenFor("admin"),
    });
    const entries = (response.body as { entries: { actorId: string }[] }).entries;

    expect(response.status).toBe(200);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.actorId === PEOPLE.district_officer.id)).toBe(true);
  });

  it("rejects a malformed time bound rather than quietly widening the query", async () => {
    server = await boot();
    const response = await server.request("/audit?from=last%20tuesday", {
      token: await tokenFor("admin"),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a nonsense limit", async () => {
    server = await boot();
    expect(
      (await server.request("/audit?limit=-5", { token: await tokenFor("admin") })).status,
    ).toBe(400);
  });
});
