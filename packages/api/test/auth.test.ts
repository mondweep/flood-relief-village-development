import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

describe("bearer-token gate", () => {
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
      expect(response.body).toEqual({ error: "missing bearer token" });
    });

    it("401s a protected route with the wrong token", async () => {
      const response = await server.request("/villages", { token: "not-the-token" });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "invalid bearer token" });
    });

    it("401s a malformed Authorization header", async () => {
      const response = await server.request("/villages", { headers: { authorization: TOKEN } });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "missing bearer token" });
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
  });
});
