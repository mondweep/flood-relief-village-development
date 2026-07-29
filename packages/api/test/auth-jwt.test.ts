import { SequentialIdGenerator } from "@afrip/shared-kernel";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthGate,
  createJwtVerifier,
  localKeySet,
  type ActorContext,
  type ProfileDirectory,
  type VerifiedClaims,
} from "../src/auth.js";
import type { ApiConfig } from "../src/config.js";
import { createMemoryRuntime } from "../src/persistence.js";
import { startTestServerWith, testConfig, type TestServer } from "./helpers.js";

/**
 * Supabase-issued JWT verification (ADR 0008).
 *
 * NOTHING here touches the network. The key pair is generated in-process, the
 * tokens are signed in-process, and the verifier is handed the resulting key set
 * directly instead of being pointed at a JWKS URL. A test that needs a live
 * Supabase project to run is a test that stops running the first time the
 * project is paused, renamed or rate-limited — and it would tell us about
 * Supabase's uptime rather than about our gate.
 */

const SUPABASE_URL = "https://proj.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const KID = "afrip-test-key";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const HS_SECRET = "legacy-shared-jwt-secret-at-least-32-bytes-long";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
type PrivateKey = KeyPair["privateKey"];
type PublicKey = KeyPair["publicKey"];

const trusted = await generateKeyPair("RS256", { extractable: true });
const impostor = await generateKeyPair("RS256", { extractable: true });

async function publicJwk(key: PublicKey): Promise<JWK> {
  return { ...(await exportJWK(key)), kid: KID, alg: "RS256", use: "sig" };
}

const TRUSTED_KEY_SET = localKeySet({ keys: [await publicJwk(trusted.publicKey)] });

interface SignOptions {
  readonly key?: PrivateKey;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly expiresIn?: number;
  readonly claims?: Record<string, unknown>;
}

/** Mints a token exactly as GoTrue would: RS256, kid, iss, aud, sub, exp. */
async function signToken(options: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresIn ?? 3600;
  return new SignJWT({ email: "field.worker@example.org", ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? "authenticated")
    .setSubject(options.subject ?? USER_ID)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + expiresIn)
    .sign(options.key ?? trusted.privateKey);
}

/** An HS256 token, the shape older Supabase projects still issue. */
async function signHs256(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: "field.worker@example.org" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setSubject(USER_ID)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(HS_SECRET));
}

const OFFICER: ActorContext = {
  id: USER_ID,
  email: "officer@darbhanga.gov.in",
  role: "district_officer",
};

/** Stands in for `assam_floods.user_profiles`. */
function fakeProfiles(rows: readonly ActorContext[] = [OFFICER]): ProfileDirectory {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return { resolve: async (claims: VerifiedClaims) => byId.get(claims.sub) ?? null };
}

interface BootOptions {
  readonly config?: Partial<ApiConfig>;
  readonly profiles?: ProfileDirectory;
  readonly jwtSecret?: string | null;
}

async function boot(options: BootOptions = {}): Promise<TestServer> {
  const config = testConfig({
    authJwt: true,
    supabaseUrl: SUPABASE_URL,
    ...options.config,
  });
  const auth = createAuthGate({
    config,
    verifier: createJwtVerifier({
      supabaseUrl: SUPABASE_URL,
      jwtSecret: options.jwtSecret ?? null,
      keySet: TRUSTED_KEY_SET,
    }),
    profiles: options.profiles ?? fakeProfiles(),
  });
  return startTestServerWith({
    config,
    runtime: createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) }),
    auth,
  });
}

describe("Supabase JWT gate", () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  it("accepts a valid token and resolves the actor from the profile store", async () => {
    server = await boot();

    const response = await server.request("/villages", { token: await signToken() });

    expect(response.status).toBe(200);
  });

  it("answers GET /me with the profile behind the token", async () => {
    server = await boot();

    const response = await server.request("/me", { token: await signToken() });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: USER_ID,
      email: "officer@darbhanga.gov.in",
      role: "district_officer",
    });
  });

  /**
   * The token's own claims are identity, never authority. A user controls their
   * signup metadata, so a `role` claim is a role they picked for themselves;
   * the profile row is the one the API wrote.
   */
  it("reads the role from the profile store, not from the token", async () => {
    server = await boot();

    const token = await signToken({
      claims: { role: "admin", user_role: "admin", email: "spoofed@example.com" },
    });
    const response = await server.request("/me", { token });

    expect(response.body).toMatchObject({ role: "district_officer", email: "officer@darbhanga.gov.in" });
  });

  // The whole point of the distinction: this one means "spend your refresh
  // token and retry", and only this one.
  it("401s an expired token with a body that says so", async () => {
    server = await boot();

    const response = await server.request("/villages", { token: await signToken({ expiresIn: -60 }) });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "token expired", code: "token_expired" });
  });

  it("401s a token signed by the wrong key, distinguishably from an expired one", async () => {
    server = await boot();

    const token = await signToken({ key: impostor.privateKey });
    const response = await server.request("/villages", { token });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "invalid token", code: "token_invalid" });
  });

  it("401s a token minted for another project (wrong iss)", async () => {
    server = await boot();

    const token = await signToken({ issuer: "https://someone-else.supabase.co/auth/v1" });
    const response = await server.request("/villages", { token });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "token_invalid" });
  });

  it("401s a token with the wrong audience", async () => {
    server = await boot();

    const response = await server.request("/villages", { token: await signToken({ audience: "anon" }) });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "token_invalid" });
  });

  it("401s a request with no token at all", async () => {
    server = await boot();

    const response = await server.request("/villages");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "missing bearer token", code: "token_missing" });
  });

  /**
   * A perfectly valid token for a user this deployment has never provisioned.
   *
   * This is intended as an authorization boundary, not a tidy-up case. The
   * Supabase project is shared with unrelated applications and GoTrue's user
   * pool is per-project, so a neighbouring application's token verifies here
   * perfectly — same issuer, same audience, same signing key. This branch is
   * what is supposed to separate "holds a token for the project" from "is a
   * user of AFRIP". If this test is ever failing, the fix is upstream of the
   * gate; do not make it pass by widening the gate.
   *
   * What this test does NOT establish — and an earlier version of this comment
   * wrongly implied it did — is that the boundary holds end to end. It pins one
   * refusal by the gate, given an unprofiled subject. Whether a neighbouring
   * app's user ARRIVES unprofiled is decided by the signup trigger in 00004,
   * which currently enrols them; see the boxed note at the top of that file.
   * A passing test here is evidence about this branch, not about the boundary.
   */
  it("401s a verified token whose subject has no profile row", async () => {
    server = await boot({ profiles: fakeProfiles([]) });

    const response = await server.request("/villages", { token: await signToken() });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "user_unknown" });
  });

  /**
   * Scope: the list below, not "the public paths". It is written out rather
   * than derived from `PUBLIC_EXACT_PATHS` on purpose — a test that reads the
   * same constant the code reads would pass for any value of it, including a
   * mistaken one. The cost of spelling it out is that adding a public path
   * leaves this green without covering it, so the name says "listed" and this
   * note says where to look: `isPublicPath` in auth.ts.
   */
  it("answers each of the listed public paths without a credential, JWT auth on", async () => {
    server = await boot();

    for (const path of ["/", "/index.html", "/health", "/ready", "/public/villages", "/public/config"]) {
      const response = await fetch(`${server.baseUrl}${path}`);
      expect(response.status, path).toBe(200);
    }
  });

  // The `//` normalisation fix from the previous gate must survive the rewrite:
  // the router treats `//villages` as `/villages`, so the gate must too, or a
  // doubled slash becomes an authentication bypass.
  it("still normalises doubled slashes so the gate and the router agree", async () => {
    server = await boot();

    const publicPath = await fetch(`${server.baseUrl}//public//villages`);
    expect(publicPath.status).toBe(200);

    const protectedPath = await fetch(`${server.baseUrl}//villages`);
    expect(protectedPath.status).toBe(401);
  });

  it("reports auth: supabase-jwt on /health", async () => {
    server = await boot();

    const response = await server.request("/health");

    expect(response.body).toMatchObject({ auth: "supabase-jwt" });
    expect((response.body as Record<string, unknown>)["legacyTokenEnabled"]).toBeUndefined();
  });

  describe("while the legacy token is still enabled alongside", () => {
    it("accepts both credentials and discloses the legacy one on /health", async () => {
      server = await boot({ config: { apiToken: "legacy-shared-token" } });

      const viaJwt = await server.request("/villages", { token: await signToken() });
      const viaLegacy = await server.request("/villages", { token: "legacy-shared-token" });
      const health = await server.request("/health");

      expect(viaJwt.status).toBe(200);
      expect(viaLegacy.status).toBe(200);
      expect(health.body).toMatchObject({ auth: "supabase-jwt", legacyTokenEnabled: true });
    });

    // An expired JWT is unmistakably a JWT. Letting it fall through to the
    // static comparison would answer "invalid" and send the browser to the
    // sign-in form when a refresh would have done.
    it("does not let an expired JWT fall through to the static comparison", async () => {
      server = await boot({ config: { apiToken: "legacy-shared-token" } });

      const response = await server.request("/villages", { token: await signToken({ expiresIn: -60 }) });

      expect(response.body).toMatchObject({ code: "token_expired" });
    });
  });

  /**
   * ADR 0008 and the brief are explicit: verification is local against a cached
   * key set. A per-request call to Supabase would put a third party's latency
   * and availability in front of every authenticated read in the platform.
   *
   * Scope first, because the name used to promise more than this establishes.
   * The verifier here holds an injected local key set, which cannot fetch
   * anything even if the code wanted it to — so this says nothing about JWKS
   * traffic. What it does rule out is the alternative implementation: verifying
   * by asking Supabase (`GET /auth/v1/user`, or a profile lookup over HTTP to
   * the project). Across three authenticated requests through the real server,
   * no call reaches the project at all.
   *
   * The remote path — the one production runs — is measured separately in
   * "key set caching" below, against a real JWKS endpoint.
   */
  it("makes no call to the project across three authenticated requests", async () => {
    server = await boot();
    const realFetch = globalThis.fetch;
    const reached: string[] = [];
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      const [input] = args;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("supabase.co")) reached.push(url);
      return realFetch(...args);
    }) as typeof fetch;

    try {
      const token = await signToken();
      for (let i = 0; i < 3; i += 1) {
        expect((await server.request("/villages", { token })).status).toBe(200);
      }
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(reached).toEqual([]);
  });
});

/**
 * Key set caching, measured against a REAL JWKS endpoint rather than an
 * injected one — this is the path production takes.
 *
 * The endpoint is a loopback server this test owns. That is not "the network"
 * in the sense the brief forbids: nothing external is reached, the result does
 * not depend on Supabase being up, and it is the same technique every other
 * suite here already uses to drive a real HTTP server.
 *
 * The scenario is adversarial on purpose. A sibling agent found a frontend bug
 * where a page that had just lost access re-issued the same failing read in an
 * unbounded loop. That is a client bug and it is fixed there — but it is also a
 * shape an attacker can produce deliberately, so the question it raises for this
 * side is worth answering: does a stream of tokens we REFUSE cost us an outbound
 * fetch each? If bogus tokens forced a JWKS re-fetch, any unauthenticated caller
 * could turn our auth gate into a traffic amplifier pointed at Supabase.
 */
describe("key set caching", () => {
  interface Jwks {
    readonly url: string;
    readonly hits: () => number;
    readonly close: () => Promise<void>;
  }

  async function jwksServer(): Promise<Jwks> {
    const document = JSON.stringify({ keys: [await publicJwk(trusted.publicKey)] });
    let hits = 0;
    const http = await import("node:http");
    const srv = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(document);
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}`,
      hits: () => hits,
      close: () =>
        new Promise<void>((resolve) => {
          srv.closeAllConnections();
          srv.close(() => resolve());
        }),
    };
  }

  it("does not spend a fetch per token, including on the refusals exercised here", async () => {
    const jwks = await jwksServer();
    const issuer = `${jwks.url}/auth/v1`;
    const verifier = createJwtVerifier({ supabaseUrl: jwks.url });

    const sign = async (key: PrivateKey, kid: string, expiresIn = 3600): Promise<string> => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuer)
        .setAudience("authenticated")
        .setSubject(USER_ID)
        .setIssuedAt(now - 10)
        .setExpirationTime(now + expiresIn)
        .sign(key);
    };

    try {
      const accepted = await sign(trusted.privateKey, KID);
      for (let i = 0; i < 10; i += 1) {
        expect((await verifier.verify(accepted)).ok).toBe(true);
      }
      expect(jwks.hits()).toBe(1);

      // Now the hostile half: 150 tokens this gate refuses, in the three shapes
      // an attacker can mint freely — an unknown `kid` (the one that could
      // plausibly force a re-fetch), a bad signature, and an expired token.
      const refused = [
        await sign(impostor.privateKey, "attacker-chosen-kid"),
        await sign(impostor.privateKey, KID),
        await sign(trusted.privateKey, KID, -60),
      ];
      for (let i = 0; i < 50; i += 1) {
        for (const token of refused) {
          expect((await verifier.verify(token)).ok).toBe(false);
        }
      }

      // 160 verifications. A per-token fetch would read 160 here; a re-fetch on
      // every unknown `kid` would read 50-odd. The bound is deliberately loose
      // rather than exact, so a jose release that spends one extra fetch on a
      // kid miss does not fail the suite — the failure being guarded is orders
      // of magnitude away from it.
      //
      // What this does NOT establish is "never re-fetches". These 160 land
      // inside jose's cooldown window; an unknown `kid` arriving after it
      // elapses is expected to cost one fetch, by design. The claim is bounded:
      // refusals do not each buy a round trip to the project.
      expect(jwks.hits()).toBeLessThanOrEqual(2);
    } finally {
      await jwks.close();
    }
  });
});

/**
 * `auth: "disabled"` on /health means "an uncredentialed request will be
 * accepted" — the dashboard reads it exactly that way, to decide whether to
 * unlock its interface on a deployment that asks for no credential. Get this
 * wrong in one direction and the page presents a locked interface over an API
 * that serves the same data to anyone; get it wrong in the other and it unlocks
 * a deployment that is genuinely gated.
 *
 * So the field is pinned to the gate's real behaviour, both ways round.
 */
describe("/health `auth` describes the gate that is actually running", () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  it('reports "disabled" only when an uncredentialed read really does succeed', async () => {
    server = await startTestServerWith({
      config: testConfig(),
      runtime: createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) }),
    });

    const health = await server.request("/health");
    const uncredentialed = await server.request("/villages");

    expect(health.body).toMatchObject({ auth: "disabled" });
    expect(uncredentialed.status).toBe(200);
  });

  it("does not report \"disabled\" while the gate is refusing requests", async () => {
    server = await boot();

    const health = await server.request("/health");
    const uncredentialed = await server.request("/villages");

    expect((health.body as Record<string, unknown>)["auth"]).not.toBe("disabled");
    expect(uncredentialed.status).toBe(401);
  });

  /**
   * The divergence this guards against. A gate can be handed a verifier
   * directly, so "config says JWT auth is off" and "this gate verifies JWTs" are
   * separable — and while `/health` computed its answer from config, it would
   * have advertised `auth: "disabled"` for a server that 401s everything. A
   * client trusting that would lock or unlock the wrong way round.
   */
  it("follows the gate, not the config, when the two could disagree", async () => {
    const config = testConfig({ authJwt: false, supabaseUrl: null });
    const auth = createAuthGate({
      config,
      verifier: createJwtVerifier({ supabaseUrl: SUPABASE_URL, keySet: TRUSTED_KEY_SET }),
      profiles: fakeProfiles(),
    });
    server = await startTestServerWith({
      config,
      runtime: createMemoryRuntime({ idGenerator: (prefix) => new SequentialIdGenerator(prefix) }),
      auth,
    });

    const health = await server.request("/health");
    const config_ = await server.request("/public/config");

    expect(health.body).toMatchObject({ auth: "supabase-jwt" });
    expect(config_.body).toMatchObject({ jwtEnabled: true });
    // ...and the gate really is refusing, which is what made "disabled" a lie.
    expect((await server.request("/villages")).status).toBe(401);
    expect((await server.request("/villages", { token: await signToken() })).status).toBe(200);
  });
});

describe("HS256 fallback", () => {
  it("verifies a shared-secret token when SUPABASE_JWT_SECRET is configured", async () => {
    const verifier = createJwtVerifier({
      supabaseUrl: SUPABASE_URL,
      jwtSecret: HS_SECRET,
      keySet: TRUSTED_KEY_SET,
    });

    const result = await verifier.verify(await signHs256());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sub).toBe(USER_ID);
  });

  it("refuses a shared-secret token when no secret is configured, rather than guessing", async () => {
    const verifier = createJwtVerifier({ supabaseUrl: SUPABASE_URL, keySet: TRUSTED_KEY_SET });

    const result = await verifier.verify(await signHs256());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("invalid");
    expect(result.detail).toContain("SUPABASE_JWT_SECRET");
  });

  it("refuses a shared-secret token signed with the wrong secret", async () => {
    const verifier = createJwtVerifier({
      supabaseUrl: SUPABASE_URL,
      jwtSecret: "a-different-secret-entirely-padded-to-length",
      keySet: TRUSTED_KEY_SET,
    });

    const result = await verifier.verify(await signHs256());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("invalid");
  });

  it("reports an unreachable key set as invalid, not as expired", async () => {
    const verifier = createJwtVerifier({
      supabaseUrl: SUPABASE_URL,
      keySet: () => {
        throw new TypeError("fetch failed");
      },
    });

    const result = await verifier.verify(await signToken());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // "invalid" and not "expired": the browser must re-authenticate rather than
    // spin on a refresh loop against an outage it cannot fix.
    expect(result.failure).toBe("invalid");
    expect(result.detail).toContain("JWKS unavailable");
  });

  it("still reports a genuinely expired token as expired, key set outage or not", async () => {
    const verifier = createJwtVerifier({ supabaseUrl: SUPABASE_URL, keySet: TRUSTED_KEY_SET });

    const result = await verifier.verify(await signToken({ expiresIn: -60 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("expired");
  });
});

describe("token that is not a JWT at all", () => {
  it("is invalid, and does not crash the verifier", async () => {
    const verifier = createJwtVerifier({ supabaseUrl: SUPABASE_URL, keySet: TRUSTED_KEY_SET });

    for (const junk of ["", "not-a-jwt", "a.b", "a.b.c", "s3cret-relief-token"]) {
      const result = await verifier.verify(junk);
      expect(result.ok, junk).toBe(false);
      if (result.ok) continue;
      expect(result.failure, junk).toBe("invalid");
    }
  });
});
