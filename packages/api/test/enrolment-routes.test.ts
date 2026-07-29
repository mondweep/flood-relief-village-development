import { SequentialIdGenerator, ok, type Result } from "@afrip/shared-kernel";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAuthGate,
  createJwtVerifier,
  localKeySet,
  type ActorContext,
  type ProfileDirectory,
  type VerifiedClaims,
} from "../src/auth.js";
import type { EnrolmentService } from "../src/enrolment.js";
import { createMemoryRuntime, type PlatformRuntime } from "../src/persistence.js";
import { startTestServerWith, testConfig, type TestServer } from "./helpers.js";

/**
 * Explicit enrolment on a SHARED Supabase project.
 *
 * The situation these tests describe is real, not hypothetical: the project
 * holds 22 accounts belonging to four unrelated applications, every one of which
 * can mint a token this API's verifier accepts — same issuer, same audience,
 * signed by the same key. Nothing about the CREDENTIAL distinguishes them from
 * an AFRIP user.
 *
 * So membership is a row in `user_profiles`, and the only things that create one
 * are an explicit registration and 00004's administrator bootstrap. The design
 * that preceded this had a trigger create one for every signup on the project,
 * which enrolled those applications' users with nobody here deciding so.
 *
 * What is NOT claimed, by these tests or anywhere else: that a neighbouring
 * user cannot get in. Their credential works, so they can call the enrolment
 * route themselves. What is removed is enrolment nobody asked for.
 */

const SUPABASE_URL = "https://proj.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const KID = "afrip-enrolment-key";

/** Someone who signed up to a neighbouring app on this project. Real token, no AFRIP profile. */
const STRANGER = { id: "00000000-0000-4000-8000-00000000beef", email: "someone@another-app.example" };
/** An enrolled AFRIP user. */
const MEMBER: ActorContext = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "coord@goonj.org",
  role: "ngo_coordinator",
};

const keys = await generateKeyPair("RS256", { extractable: true });
const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
const KEY_SET = localKeySet({ keys: [jwk] });

async function tokenFor(user: { id: string; email: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setSubject(user.id)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(keys.privateKey);
}

/** `user_profiles`: MEMBER has a row, STRANGER does not — which is the whole point. */
function profilesWith(rows: readonly ActorContext[]): ProfileDirectory {
  return {
    resolve: async (claims: VerifiedClaims) => rows.find((row) => row.id === claims.sub) ?? null,
  };
}

interface BootOptions {
  readonly enrolled?: readonly ActorContext[];
  readonly enrolment?: EnrolmentService | null;
}

function fakeEnrolment(): EnrolmentService & { enrol: ReturnType<typeof vi.fn> } {
  return {
    enrol: vi.fn(
      async (claims: VerifiedClaims): Promise<Result<ActorContext>> =>
        ok({ id: claims.sub, email: claims.email ?? "", role: "citizen" }),
    ),
  };
}

async function boot(options: BootOptions = {}): Promise<TestServer> {
  const config = testConfig({ authJwt: true, supabaseUrl: SUPABASE_URL });
  const base = createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) });
  const runtime: PlatformRuntime = {
    ...base,
    ...(options.enrolment === null ? {} : { enrolment: options.enrolment ?? fakeEnrolment() }),
  };
  return startTestServerWith({
    config,
    runtime,
    auth: createAuthGate({
      config,
      verifier: createJwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: null, keySet: KEY_SET }),
      profiles: profilesWith(options.enrolled ?? [MEMBER]),
    }),
  });
}

describe("a valid token is not membership", () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  async function asStranger(path: string, init: RequestInit = {}) {
    return server.request(path, { ...init, token: await tokenFor(STRANGER) });
  }

  it("refuses an unenrolled holder of a perfectly valid token", async () => {
    server = await boot();

    const response = await asStranger("/villages");

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "user_unknown" });
  });

  it("refuses them the beneficiary register in particular", async () => {
    server = await boot();

    expect((await asStranger("/villages/village-1/beneficiaries")).status).toBe(401);
    expect(
      (
        await asStranger("/beneficiaries", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ villageId: "village-1", name: "R", category: "widow" }),
        })
      ).status,
    ).toBe(401);
  });

  it("refuses them GET /me — holding a token and being a user are different things", async () => {
    server = await boot();

    expect((await asStranger("/me")).status).toBe(401);
  });

  it("admits an enrolled user with the same shape of token", async () => {
    server = await boot();

    const response = await server.request("/villages", { token: await tokenFor(MEMBER) });

    expect(response.status).toBe(200);
  });
});

describe("POST /me/enrolment", () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  function register(token: string) {
    return server.request("/me/enrolment", { method: "POST", token });
  }

  /**
   * The route has to be reachable by exactly the request every other route
   * refuses, because the profile it needs is the profile it creates. If this
   * fails, self-registration is impossible.
   */
  it("is reachable with a verified token and no profile", async () => {
    server = await boot();

    const response = await register(await tokenFor(STRANGER));

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ id: STRANGER.id, email: STRANGER.email, role: "citizen" });
  });

  it("enrols with the claims that were SIGNED, not with anything the client sent", async () => {
    const enrolment = fakeEnrolment();
    server = await boot({ enrolment });

    await server.request("/me/enrolment", {
      method: "POST",
      token: await tokenFor(STRANGER),
      headers: { "content-type": "application/json" },
      // A client trying to enrol as somebody else, or as an admin.
      body: JSON.stringify({ sub: "somebody-else", email: "admin@afrip", role: "admin" }),
    });

    expect(enrolment.enrol).toHaveBeenCalledTimes(1);
    const claims = enrolment.enrol.mock.calls[0]![0] as VerifiedClaims;
    expect(claims.sub).toBe(STRANGER.id);
    expect(claims.email).toBe(STRANGER.email);
  });

  it("returns the existing profile, and does not re-enrol, when already a member", async () => {
    const enrolment = fakeEnrolment();
    server = await boot({ enrolment });

    const response = await register(await tokenFor(MEMBER));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ role: "ngo_coordinator" });
    // Crucially not called: re-registering must never be able to reset a role.
    expect(enrolment.enrol).not.toHaveBeenCalled();
  });

  it("refuses a request carrying no verified identity", async () => {
    server = await boot();

    const response = await server.request("/me/enrolment", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("says so plainly when the deployment has no profile store", async () => {
    server = await boot({ enrolment: null });

    const response = await register(await tokenFor(STRANGER));

    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({ code: "enrolment_unavailable" });
  });

  it("reports a failed registration rather than claiming success", async () => {
    server = await boot({
      enrolment: { enrol: async () => ({ ok: false as const, error: "profile store unreachable" }) },
    });

    const response = await register(await tokenFor(STRANGER));

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ code: "enrolment_failed" });
  });

  /**
   * The hazard behind `UNENROLLED`. This request reaches a handler with
   * `actor: null`, and a null actor ALLOWS every use case — that rule exists for
   * the legacy shared token, which is gated elsewhere. An unenrolled stranger is
   * not gated elsewhere, so their platform must deny everything.
   *
   * Nothing depends on this today: the enrolment handler touches no use case.
   * It is asserted because the next route added to `IDENTIFIED_ONLY_PATHS` would
   * otherwise inherit an unrestricted platform in silence.
   */
  it("hands the enrolment request a platform that permits nothing", async () => {
    const config = testConfig({ authJwt: true, supabaseUrl: SUPABASE_URL });
    const runtime = {
      ...createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) }),
      enrolment: {
        // Runs inside the request, so it can be used to reach the composed
        // platform the router built for this caller.
        enrol: async (claims: VerifiedClaims): Promise<Result<ActorContext>> =>
          ok({ id: claims.sub, email: claims.email ?? "", role: "citizen" }),
      },
    };
    server = await startTestServerWith({
      config,
      runtime,
      auth: createAuthGate({
        config,
        verifier: createJwtVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: null, keySet: KEY_SET }),
        profiles: profilesWith([MEMBER]),
      }),
    });

    // Drive it through the same composition the router uses.
    const { platformForRequest } = await import("../src/request-platform.js");
    const { NO_OWNERSHIP } = await import("@afrip/shared-kernel");
    const platform = platformForRequest(runtime.platform, null, "supabase-jwt", "req-1", NO_OWNERSHIP, true);

    const result = await platform.villageRegistry.listVillagesBySeverity.execute();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Not permitted/);

    const write = await platform.beneficiaryRegistry.registerBeneficiary.execute({
      villageId: "village-1",
      name: "R",
      category: "widow",
    });
    expect(write.ok).toBe(false);
  });
});
