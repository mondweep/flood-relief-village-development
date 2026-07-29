import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

/**
 * The transitional shared-token path (ADR 0008).
 *
 * It still works, on purpose: both paths are accepted while clients migrate to
 * Supabase sign-in. What it does NOT do is establish an identity — see the
 * `/me` assertion at the bottom, and `auth-jwt.test.ts` for the path that does.
 */
describe("legacy bearer-token gate", () => {
  describe("when API_TOKEN is set", () => {
    let server: TestServer;

    beforeEach(async () => {
      server = await startTestServer({ apiToken: TOKEN });
    });

    afterEach(async () => {
      await server.close();
    });

    it("401s a protected route with no Authorization header", async () => {
      const response = await server.request("/villages");

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "missing bearer token", code: "token_missing" });
    });

    it("401s a protected route with the wrong token", async () => {
      const response = await server.request("/villages", { token: "not-the-token" });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "invalid token", code: "token_invalid" });
    });

    it("401s a malformed Authorization header", async () => {
      const response = await server.request("/villages", { headers: { authorization: TOKEN } });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "missing bearer token", code: "token_missing" });
    });

    it("challenges with WWW-Authenticate", async () => {
      const response = await fetch(`${server.baseUrl}/villages`);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="afrip"');
    });

    it("401s writes too, before the body is even parsed", async () => {
      const response = await server.request("/villages", jsonBody(VILLAGE_BODY));

      expect(response.status).toBe(401);
    });

    it("allows a protected route with the correct token", async () => {
      const response = await server.request("/villages", { ...jsonBody(VILLAGE_BODY), token: TOKEN });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ villageId: "village-1" });
    });

    it("leaves /health and /ready open for the Cloud Run probes", async () => {
      const health = await server.request("/health");
      const ready = await server.request("/ready");

      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: "ok", auth: "bearer" });
      expect(ready.status).toBe(200);
    });

    /**
     * ADR 0008: "`/health` must disclose when the legacy path is still enabled —
     * a transitional weakness that is invisible is a transitional weakness that
     * becomes permanent."
     */
    it("discloses on /health that the legacy token is still accepted", async () => {
      const health = await server.request("/health");

      expect(health.body).toMatchObject({ legacyTokenEnabled: true });
      expect(String((health.body as Record<string, unknown>)["legacyTokenWarning"])).toContain(
        "API_TOKEN is still accepted",
      );
    });

    /**
     * A shared secret proves possession, not personhood. Answering /me with a
     * fabricated user would be worse than refusing — and the refusal is what
     * pushes a client onto the Supabase path.
     */
    it("refuses GET /me: a shared token identifies nobody", async () => {
      const response = await server.request("/me", { token: TOKEN });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "identity_unavailable" });
    });

    it("leaves /public/villages open without any credential", async () => {
      const response = await server.request("/public/villages");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ villages: [] });
    });

    it("still 404s an unknown public path rather than leaking route existence checks", async () => {
      const response = await server.request("/public/unknown");

      expect(response.status).toBe(404);
    });
  });

  describe("when API_TOKEN is unset", () => {
    let server: TestServer;

    beforeEach(async () => {
      server = await startTestServer({ apiToken: null });
    });

    afterEach(async () => {
      await server.close();
    });

    it("serves protected routes without a token and marks /health as unauthenticated", async () => {
      const villages = await server.request("/villages");
      const health = await server.request("/health");

      expect(villages.status).toBe(200);
      expect(health.body).toMatchObject({ auth: "disabled" });
    });

    // The disclosure is a disclosure, not a permanent field: there is no
    // transitional weakness to announce once the token is gone.
    it("omits both legacy-token fields when the legacy path is not enabled", async () => {
      const health = await server.request("/health");
      const body = health.body as Record<string, unknown>;

      expect(body["legacyTokenEnabled"]).toBeUndefined();
      expect(body["legacyTokenWarning"]).toBeUndefined();
    });
  });
});

describe("GET /public/config", () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  it("serves the GoTrue URL, publishable key and provider list, unauthenticated", async () => {
    server = await startTestServer({
      apiToken: "legacy",
      authJwt: true,
      supabaseUrl: "https://proj.supabase.co",
      supabasePublishableKey: "sb_publishable_abc",
    });

    const response = await server.request("/public/config");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      supabaseUrl: "https://proj.supabase.co",
      supabasePublishableKey: "sb_publishable_abc",
      authProviders: ["google"],
      googleEnabled: true,
      jwtEnabled: true,
      legacyTokenEnabled: true,
    });
  });

  /**
   * 200-with-nulls rather than 404. "Sign-in is not configured here" and "that
   * endpoint does not exist" are different problems for different people, and
   * the page renders them differently.
   */
  it("answers 200 with nulls when auth is not configured, rather than 404", async () => {
    server = await startTestServer();

    const response = await server.request("/public/config");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      supabaseUrl: null,
      supabasePublishableKey: null,
      jwtEnabled: false,
      legacyTokenEnabled: false,
    });
  });

  /**
   * The trap state: a Supabase project IS configured, so `supabaseUrl` and the
   * publishable key are both present and a page checking only those would offer
   * sign-in — but this revision verifies nothing, so the user would authenticate
   * successfully and be refused on the very next request. `jwtEnabled` is the
   * field that tells the page not to open that door, which makes it load-bearing
   * rather than informational.
   *
   * Reachable by accident: SUPABASE_URL is also what PERSISTENCE=supabase needs.
   */
  it("reports jwtEnabled false when a project is configured but not being verified", async () => {
    server = await startTestServer({
      authJwt: false,
      persistence: "supabase",
      supabaseUrl: "https://proj.supabase.co",
      supabaseServiceRoleKey: "service-role-key",
      supabasePublishableKey: "sb_publishable_abc",
    });

    const response = await server.request("/public/config");

    expect(response.body).toMatchObject({
      supabaseUrl: "https://proj.supabase.co",
      supabasePublishableKey: "sb_publishable_abc",
      jwtEnabled: false,
    });
  });

  it("omits the service-role key from the payload", async () => {
    server = await startTestServer({
      supabaseUrl: "https://proj.supabase.co",
      supabaseServiceRoleKey: "service-role-key-DO-NOT-LEAK",
      supabasePublishableKey: "sb_publishable_abc",
    });

    const response = await server.request("/public/config");

    expect(JSON.stringify(response.body)).not.toContain("service-role-key-DO-NOT-LEAK");
  });
});
