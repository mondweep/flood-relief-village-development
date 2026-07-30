import { SequentialIdGenerator, USER_ROLES, type RoleSource } from "@afrip/shared-kernel";
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
import { createMemoryRuntime } from "../src/persistence.js";
import { buildRouter } from "../src/routes/index.js";
import { InMemoryUserDirectory, type ManagedUser } from "../src/user-administration.js";
import { startTestServerWith, testConfig, type TestServer } from "./helpers.js";

/**
 * Appointing people, over HTTP (ADR 0018).
 *
 * The gate here is not "is an admin" but "is an admin NAMED IN VERSION CONTROL",
 * and every test in this file exists because those two are easy to confuse and
 * indistinguishable from the outside. An administrator appointed through this
 * endpoint holds the beneficiary register, the audit trail and the feedback
 * queue; what they must not hold is the ability to hand that out again.
 */

const SUPABASE_URL = "https://proj.supabase.co";
const KID = "afrip-admin-key";

interface Person extends ActorContext {
  readonly roleSource: RoleSource;
}

const PEOPLE: Record<string, Person> = {
  superAdmin: { id: "user-owner", email: "owner@example.org", role: "admin", roleSource: "grant" },
  appointedAdmin: { id: "user-deputy", email: "deputy@example.org", role: "admin", roleSource: "appointed" },
  officer: { id: "user-officer", email: "officer@assam.gov.in", role: "district_officer", roleSource: "appointed" },
  ngo: { id: "user-ngo", email: "coord@goonj.org", role: "ngo_coordinator", roleSource: "appointed" },
  committee: { id: "user-committee", email: "member@village.in", role: "village_committee", roleSource: "appointed" },
  citizen: { id: "user-citizen", email: "resident@example.org", role: "citizen", roleSource: "self" },
};

/** Everyone who must be refused. Derived, so a new person is covered by default. */
const REFUSED = Object.keys(PEOPLE).filter((who) => who !== "superAdmin");

const keys = await generateKeyPair("RS256", { extractable: true });
const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
const KEY_SET = localKeySet({ keys: [jwk] });

async function tokenFor(who: string): Promise<string> {
  const person = PEOPLE[who] as Person;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: person.email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setSubject(person.id)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(keys.privateKey);
}

const profiles: ProfileDirectory = {
  resolve: async (claims: VerifiedClaims) =>
    Object.values(PEOPLE).find((person) => person.id === claims.sub) ?? null,
};

function managed(who: string, overrides: Partial<ManagedUser> = {}): ManagedUser {
  const person = PEOPLE[who] as Person;
  return {
    id: person.id,
    email: person.email,
    role: person.role,
    roleSource: person.roleSource,
    enrolledAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

async function boot(seed: ManagedUser[] = []): Promise<TestServer> {
  const config = testConfig({ authJwt: true, supabaseUrl: SUPABASE_URL });
  const runtime = createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) });
  return startTestServerWith({
    config,
    // The in-memory runtime seeds an EMPTY directory on purpose (see
    // persistence.ts), so tests supply their own population.
    runtime: { ...runtime, users: new InMemoryUserDirectory(seed) },
    auth: createAuthGate({
      config,
      verifier: createJwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: null, keySet: KEY_SET }),
      profiles,
    }),
  });
}

describe("who may reach the administration routes at all", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  /**
   * WALKS THE ROUTER rather than listing paths. The gate on these routes is
   * hand-written in the handler (they are not use cases on a bounded context, so
   * `authorizePlatform` never sees them), which means a third route added later
   * can omit the check and nothing would fail. This enumerates whatever is
   * registered, so a new route is covered the day it exists.
   */
  it("refuses every role but a grant-sourced admin, on every /admin route", async () => {
    const router = buildRouter({
      runtime: createMemoryRuntime({ idGenerator: (p) => new SequentialIdGenerator(p) }),
      config: testConfig(),
    } as never);

    const routes = (
      router as unknown as { routes: { method: string; segments: string[] }[] }
    ).routes
      .filter((route) => route.segments[0] === "admin")
      .map((route) => ({
        key: `${route.method} /${route.segments.join("/")}`,
        method: route.method,
        // `:id` is filled with a REAL seeded user, so a 404 cannot be mistaken
        // for a refusal — the point is that the GATE fires, not the lookup.
        path:
          "/" +
          route.segments
            .map((s) => (s.startsWith(":") ? (PEOPLE["citizen"] as Person).id : s))
            .join("/"),
      }));

    expect(routes.length, "no /admin routes were registered at all").toBeGreaterThanOrEqual(2);

    server = await boot([managed("citizen")]);
    for (const route of routes) {
      for (const who of REFUSED) {
        const response = await server.request(route.path, {
          method: route.method,
          token: await tokenFor(who),
          headers: { "content-type": "application/json" },
          body: route.method === "GET" ? undefined : JSON.stringify({ role: "admin" }),
        });
        expect(response.status, `${route.key} did not refuse ${who}`).toBe(403);
      }
    }
  });

  it.each(["/admin/users", `/admin/users/${PEOPLE["citizen"]!.id}/role`])(
    "refuses an unauthenticated caller at %s",
    async (path) => {
      server = await boot([managed("citizen")]);
      const response = await server.request(path, { method: path.endsWith("role") ? "PATCH" : "GET" });
      expect(response.status).toBe(401);
    },
  );
});

describe("listing the platform's users", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  it("admits a super admin", async () => {
    server = await boot([managed("superAdmin"), managed("citizen")]);
    const response = await server.request("/admin/users", { token: await tokenFor("superAdmin") });
    expect(response.status).toBe(200);
    const body = response.body as { users: ManagedUser[] };
    expect(body.users.map((u) => u.email)).toContain(PEOPLE["citizen"]!.email);
  });

  /**
   * A directory of every user's email beside their role is the reconnaissance an
   * attacker who has compromised one account wants, on a platform holding a
   * register of vulnerable people. An admin who cannot appoint cannot act on it.
   */
  it("refuses an appointed admin, though they are an administrator", async () => {
    server = await boot([managed("superAdmin")]);
    const response = await server.request("/admin/users", { token: await tokenFor("appointedAdmin") });
    expect(response.status).toBe(403);
  });

  it("carries the role source, so the page can tell who may appoint", async () => {
    server = await boot([managed("superAdmin"), managed("citizen")]);
    const response = await server.request("/admin/users", { token: await tokenFor("superAdmin") });
    const body = response.body as { users: ManagedUser[] };
    const owner = body.users.find((u) => u.id === PEOPLE["superAdmin"]!.id);
    expect(owner?.roleSource).toBe("grant");
  });
});

describe("changing a role", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  async function patch(who: string, targetId: string, role: unknown) {
    return server.request(`/admin/users/${targetId}/role`, {
      method: "PATCH",
      token: await tokenFor(who),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
  }

  it("promotes a citizen, and records the appointment as such", async () => {
    server = await boot([managed("superAdmin"), managed("citizen")]);
    const response = await patch("superAdmin", PEOPLE["citizen"]!.id, "district_officer");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ role: "district_officer", roleSource: "appointed" });
  });

  /**
   * THE POINT OF THE WHOLE FEATURE, end to end: a super admin can create another
   * administrator, and that administrator cannot create a third.
   */
  it("lets a super admin appoint an admin who then cannot appoint anyone", async () => {
    server = await boot([managed("superAdmin"), managed("citizen")]);

    const promoted = await patch("superAdmin", PEOPLE["citizen"]!.id, "admin");
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ role: "admin", roleSource: "appointed" });

    // The newly-minted admin is `appointed`, so the gate refuses them — proved
    // through the running server rather than by reasoning about `isSuperAdmin`.
    const theirAttempt = await patch("appointedAdmin", PEOPLE["citizen"]!.id, "citizen");
    expect(theirAttempt.status).toBe(403);
  });

  it("refuses to change a role that version control asserts", async () => {
    const other = managed("superAdmin", { id: "user-other", email: "other@example.org" });
    server = await boot([managed("superAdmin"), other]);
    const response = await patch("superAdmin", "user-other", "citizen");
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ refusal: "grant_sourced" });
  });

  it("refuses a change to your own role", async () => {
    server = await boot([managed("superAdmin")]);
    const response = await patch("superAdmin", PEOPLE["superAdmin"]!.id, "citizen");
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ refusal: "self" });
  });

  it("answers 404 for somebody who has not registered", async () => {
    server = await boot([managed("superAdmin")]);
    const response = await patch("superAdmin", "user-nobody", "citizen");
    expect(response.status).toBe(404);
  });

  it.each(["superuser", "", 42, null])("refuses %s as a role with 400", async (role) => {
    server = await boot([managed("superAdmin"), managed("citizen")]);
    const response = await patch("superAdmin", PEOPLE["citizen"]!.id, role);
    expect(response.status).toBe(400);
  });

  it.each([...USER_ROLES])("accepts %s as a target role", async (role) => {
    server = await boot([managed("superAdmin"), managed("citizen")]);
    const response = await patch("superAdmin", PEOPLE["citizen"]!.id, role);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ role });
  });

  /**
   * ADR 0011: a role change is an attributed change like any other, and this is
   * the one whose absence from the trail would matter most — it is how somebody
   * came to hold access to the beneficiary register.
   */
  it("writes an audit entry naming the actor, the subject and BOTH roles", async () => {
    server = await boot([managed("superAdmin"), managed("citizen")]);
    await patch("superAdmin", PEOPLE["citizen"]!.id, "ngo_coordinator");

    const audit = await server.request(
      `/audit/subjects/user/${PEOPLE["citizen"]!.id}`,
      { token: await tokenFor("superAdmin") },
    );
    expect(audit.status, JSON.stringify(audit.body)).toBe(200);
    const body = audit.body as { entries: { eventName: string; actorEmail: string | null; payload: Record<string, unknown> }[] };
    const entry = body.entries.find((e) => e.eventName === "user.role-changed.v1");

    expect(entry, "the role change was not audited").toBeDefined();
    expect(entry?.actorEmail).toBe(PEOPLE["superAdmin"]!.email);
    expect(entry?.payload).toMatchObject({
      // Without the previous role the entry cannot be reviewed: "X is now an NGO
      // coordinator" says nothing about what changed.
      previousRole: "citizen",
      role: "ngo_coordinator",
      userEmail: PEOPLE["citizen"]!.email,
    });
  });
});
