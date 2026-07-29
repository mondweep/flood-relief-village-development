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
import { startTestServerWith, testConfig, type TestServer } from "./helpers.js";

/**
 * ADR 0009 over real HTTP.
 *
 * Everything else about authorization is tested against doubles in
 * `packages/platform`. This file exists because those tests cannot answer the
 * question that actually matters: does a signed-in citizen, making a real
 * request to a real server, get refused the beneficiary register? Every link has
 * to hold — the JWT gate resolving a profile, the request-scoped composition,
 * the wrapper, the Result-to-403 mapping, and for read ports the thrown refusal
 * surviving the dispatcher's catch-all. A unit test of any single link would
 * pass with two of the others unwired.
 *
 * No network: the key pair is generated in-process and the verifier is handed
 * the key set directly, exactly as auth-jwt.test.ts does.
 */

const SUPABASE_URL = "https://proj.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const KID = "afrip-authz-key";

const keys = await generateKeyPair("RS256", { extractable: true });
const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
const KEY_SET = localKeySet({ keys: [jwk] });

const PEOPLE: Record<UserRole, ActorContext> = {
  admin: { id: "user-admin", email: "mondweep@dxsure.uk", role: "admin" },
  district_officer: { id: "user-officer", email: "officer@assam.gov.in", role: "district_officer" },
  ngo_coordinator: { id: "user-ngo", email: "coord@goonj.org", role: "ngo_coordinator" },
  village_committee: { id: "user-committee", email: "member@village.in", role: "village_committee" },
  citizen: { id: "user-citizen", email: "resident@example.org", role: "citizen" },
};

async function tokenFor(role: UserRole): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: PEOPLE[role].email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setSubject(PEOPLE[role].id)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(keys.privateKey);
}

/** Stands in for `assam_floods.user_profiles`: every role has an account. */
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
  geo: { lat: 26.95, lng: 94.17, source: "manual_entry" },
  population: 900,
  households: 200,
  affectedFamilies: 120,
  severity: "severe",
};

const ISSUE = {
  villageId: "village-1",
  category: "water",
  description: "Handpump contaminated after the flood",
  gps: { lat: 26.95, lng: 94.17 },
};

describe("role enforcement over HTTP (ADR 0009)", () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  async function as(role: UserRole, path: string, init: RequestInit = {}) {
    return server.request(path, { ...init, token: await tokenFor(role) });
  }

  async function post(role: UserRole, path: string, body: unknown) {
    return as(role, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // -------------------------------------------------------------------------
  // The register this ADR exists to close
  // -------------------------------------------------------------------------

  it("refuses a citizen the beneficiary register with 403, not 401 and not 400", async () => {
    server = await boot();

    const response = await post("citizen", "/beneficiaries", {
      villageId: "village-1",
      name: "Rekha Das",
      category: "widow",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: FORBIDDEN_CODE });
    // 401 would send the browser off to refresh a token that is perfectly fine,
    // and 400 would read as "your request was malformed". Both are wrong answers
    // to "your account may not do this".
    expect(response.status).not.toBe(401);
  });

  it("names the role in the refusal, so the message is actionable", async () => {
    server = await boot();

    const response = await post("citizen", "/beneficiaries", {
      villageId: "village-1",
      name: "Rekha Das",
      category: "widow",
    });

    expect((response.body as { error: string }).error).toMatch(/citizen/);
    expect((response.body as { error: string }).error).toMatch(/register beneficiaries/);
  });

  it("refuses a village committee member too — they are staff, not registry staff", async () => {
    server = await boot();

    const response = await post("village_committee", "/beneficiaries", {
      villageId: "village-1",
      name: "Arun Bora",
      category: "orphan",
    });

    expect(response.status).toBe(403);
  });

  it("admits an NGO coordinator, who is who the register is for", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);

    const response = await post("ngo_coordinator", "/beneficiaries", {
      villageId: "village-1",
      name: "Rekha Das",
      category: "widow",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  /**
   * The gate is a gate, not a filter: a refused write must leave nothing behind.
   * Asserted through the API rather than by inspecting the repository, because
   * the repository is exactly what a filter-shaped bug would still have written to.
   */
  it("writes nothing when it refuses", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);

    await post("citizen", "/beneficiaries", { villageId: "village-1", name: "Rekha Das", category: "widow" });
    const roster = await as("district_officer", "/villages/village-1/beneficiaries");

    expect((roster.body as { beneficiaries: unknown[] }).beneficiaries).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // What a citizen CAN do
  // -------------------------------------------------------------------------

  it("lets a citizen report an issue — the input the platform is built around", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);

    const response = await post("citizen", "/issues", ISSUE);

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("lets a citizen read villages and register as a volunteer", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);

    expect((await as("citizen", "/villages")).status).toBe(200);
    expect((await as("citizen", "/villages/village-1")).status).toBe(200);
    expect(
      (await post("citizen", "/volunteers", { name: "Bhaskar", skills: ["boat"], languages: ["as"], location: "Majuli" }))
        .status,
    ).toBe(201);
  });

  it("refuses a citizen the write paths on villages", async () => {
    server = await boot();

    expect((await post("citizen", "/villages", VILLAGE)).status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Ownership widens, which is the "edit what you made" requirement
  // -------------------------------------------------------------------------

  /**
   * The full ownership loop over HTTP: a citizen reports an issue, the ownership
   * row is written by the publishing decorator during that very request, and the
   * follow-up call — which their role alone would be refused — is admitted
   * because they own the record.
   *
   * This is the one test that fails if the decorator nesting in
   * `composeForActor` is inverted, since the unstamped events it would then see
   * record no owner.
   */
  it("lets a citizen progress an issue they reported, and refuses one they did not", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);

    const mine = await post("citizen", "/issues", ISSUE);
    const theirs = await post("village_committee", "/issues", ISSUE);
    const mineId = (mine.body as { issueId: string }).issueId;
    const theirsId = (theirs.body as { issueId: string }).issueId;
    expect(mineId).not.toEqual(theirsId);
    // `startProgress` requires a routed issue — routing is an officer's job and
    // is not what this test is about, so both are routed first by someone who may.
    await post("district_officer", `/issues/${mineId}/route`, {});
    await post("district_officer", `/issues/${theirsId}/route`, {});

    const onMine = await post("citizen", `/issues/${mineId}/start`, {});
    const onTheirs = await post("citizen", `/issues/${theirsId}/start`, {});

    expect(onMine.status, JSON.stringify(onMine.body)).toBe(200);
    expect(onTheirs.status).toBe(403);
  });

  /**
   * Ownership widens rights; it must never narrow them. An officer editing a
   * record they did not create is not a special case to be forgiven, it is the
   * ordinary one.
   */
  it("lets an officer act on an issue a citizen reported", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);
    const reported = await post("citizen", "/issues", ISSUE);
    const issueId = (reported.body as { issueId: string }).issueId;
    await post("district_officer", `/issues/${issueId}/route`, {});

    const response = await post("district_officer", `/issues/${issueId}/start`, {});

    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  /**
   * Verification is deliberately NOT ownable — a second pair of eyes that can be
   * the same pair certifies nothing. The reporter is refused even though they
   * own the issue, which is the one place ownership is expected to lose.
   */
  it("refuses the reporter the verification of their own issue", async () => {
    server = await boot();
    await post("district_officer", "/villages", VILLAGE);
    const reported = await post("citizen", "/issues", ISSUE);
    const issueId = (reported.body as { issueId: string }).issueId;
    await post("district_officer", `/issues/${issueId}/route`, {});
    await post("district_officer", `/issues/${issueId}/start`, {});
    await post("district_officer", `/issues/${issueId}/resolve`, { resolutionNote: "New handpump sunk" });

    const response = await post("citizen", `/issues/${issueId}/verify`, {});

    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Read ports refuse by THROWING, which is a different path to the same 403
  // -------------------------------------------------------------------------

  /**
   * `GET /volunteers` reads the repository port directly — it returns a raw
   * array, not a `Result`, so a refusal has nowhere to live except a rejected
   * promise. That rejection travels all the way out to `createHandler`'s
   * catch-all, which must recognise it as a refusal rather than logging it as an
   * unhandled error and answering 500.
   */
  it("answers 403, not 500, when a denied read port throws", async () => {
    server = await boot();

    const response = await as("citizen", "/volunteers");

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: FORBIDDEN_CODE });
  });

  it("still serves the leaderboard, which is the aggregate view a citizen may have", async () => {
    server = await boot();

    expect((await as("citizen", "/volunteers/leaderboard")).status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // admin
  // -------------------------------------------------------------------------

  it("lets the admin through everywhere without appearing in a single rule", async () => {
    server = await boot();
    await post("admin", "/villages", VILLAGE);

    expect((await post("admin", "/beneficiaries", { villageId: "village-1", name: "R", category: "widow" })).status)
      .toBe(201);
    expect((await as("admin", "/volunteers")).status).toBe(200);
    expect(
      (await post("admin", "/ngos", { name: "Goonj", focusAreas: ["shelter"], capacity: 5 })).status,
    ).toBe(201);
  });

  // -------------------------------------------------------------------------
  // The public surface is unaffected
  // -------------------------------------------------------------------------

  it("leaves the unauthenticated public projection open", async () => {
    server = await boot();

    expect((await server.request("/public/villages")).status).toBe(200);
    expect((await server.request("/health")).status).toBe(200);
  });
});
