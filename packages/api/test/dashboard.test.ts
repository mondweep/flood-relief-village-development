import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_HTML } from "../src/routes/dashboard.js";
import { startTestServer, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

/**
 * A marker only the real dashboard carries. Asserting on this rather than on a
 * byte count is what makes the test meaningful: a stub, an empty file or a
 * placeholder would all satisfy `length > 0`, and none of them would satisfy
 * this. It is deliberately ASCII so the same string can be grepped out of the
 * built `dist/server.js` to prove the markup really was inlined.
 */
const MARKER = "AFRIP";
// Matches the <title>. Deliberately a substring rather than the full title, so
// renaming the product surface does not fail a test about whether HTML is being
// served at all — but specific enough that an empty or placeholder document does.
const TITLE_MARKER = "AFRIP";

describe("dashboard document", () => {
  it("is inlined into the bundle as a non-trivial HTML string", () => {
    expect(typeof DASHBOARD_HTML).toBe("string");
    expect(DASHBOARD_HTML.toLowerCase()).toContain("<!doctype html>");
    expect(DASHBOARD_HTML).toContain(MARKER);
    expect(DASHBOARD_HTML).toContain(TITLE_MARKER);
    expect(DASHBOARD_HTML).toContain("</html>");
  });

  /**
   * Documents a coupling that lives in another file: `routes/dashboard.ts` can
   * only import `.html` because the root `package.json` build script passes
   * `--loader:.html=text` to esbuild.
   *
   * Measured, not assumed: removing that flag makes `npm run build` exit 1 with
   * an esbuild "No loader is configured for .html files" error. So this is NOT
   * guarding a silent failure — the build breaks loudly on its own. What this
   * adds is a failure that names the cause, in the suite of the package that
   * depends on it, rather than an esbuild error in a root script that says
   * nothing about why the flag is there or who needs it.
   *
   * Asserting on the script text rather than on a built artifact is deliberate:
   * it is deterministic, needs no prior `npm run build`, and cannot pass against
   * a stale `dist/` left over from an earlier build that did have the flag.
   */
  it("keeps the esbuild loader that makes the HTML import resolve", () => {
    const pkg = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
    const build = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts?.["build"] ?? "";

    expect(
      build,
      "root package.json build script must keep --loader:.html=text — without it " +
        "the dashboard's HTML import cannot resolve and npm run build fails",
    ).toContain("--loader:.html=text");
  });
});

describe("GET / and /index.html", () => {
  describe("with no API_TOKEN configured", () => {
    let server: TestServer;

    beforeEach(async () => {
      server = await startTestServer({ apiToken: null });
    });

    afterEach(async () => {
      await server.close();
    });

    it("serves the dashboard as HTML", async () => {
      const response = await fetch(`${server.baseUrl}/`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(body).toContain(TITLE_MARKER);
    });

    it("sends a revalidating cache-control and an honest content-length", async () => {
      const response = await fetch(`${server.baseUrl}/`);
      const body = await response.text();

      expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
      // The HTML is not ASCII-only, so a naive length would be wrong here.
      expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
    });

    it("serves the identical document at /index.html", async () => {
      const root = await (await fetch(`${server.baseUrl}/`)).text();
      const explicit = await (await fetch(`${server.baseUrl}/index.html`)).text();

      expect(explicit).toBe(root);
      expect(explicit).toBe(DASHBOARD_HTML);
    });
  });

  describe("with API_TOKEN set", () => {
    let server: TestServer;

    beforeEach(async () => {
      server = await startTestServer({ apiToken: TOKEN });
    });

    afterEach(async () => {
      await server.close();
    });

    it("still serves / without a bearer token — it is the login surface", async () => {
      const response = await fetch(`${server.baseUrl}/`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(body).toContain(TITLE_MARKER);
    });

    it("leaves /index.html open too", async () => {
      const response = await fetch(`${server.baseUrl}/index.html`);

      expect(response.status).toBe(200);
    });

    it("keeps the API itself gated while the shell is open", async () => {
      const dashboard = await fetch(`${server.baseUrl}/`);
      const api = await fetch(`${server.baseUrl}/villages`);

      expect(dashboard.status).toBe(200);
      expect(api.status).toBe(401);
    });

    it("accepts / with the router's tolerated slash forms", async () => {
      // The router treats "//" as the root path; the auth gate must agree, or a
      // request would route to the dashboard and be 401'd on the way in.
      const response = await fetch(`${server.baseUrl}//`);

      expect(response.status).toBe(200);
    });

    it("does not let a doubled slash launder a protected route past the gate", async () => {
      // "//villages" is the same route to the router, so it must be the same
      // route to the auth gate — not silently re-read as the public root.
      const response = await fetch(`${server.baseUrl}//villages`);

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    });
  });

  describe("the API does not become a single-page app", () => {
    let server: TestServer;

    beforeEach(async () => {
      server = await startTestServer({ apiToken: null });
    });

    afterEach(async () => {
      await server.close();
    });

    it("404s an unknown path with JSON, not the dashboard", async () => {
      const response = await fetch(`${server.baseUrl}/definitely-not-a-route`);
      const body = await response.text();

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(JSON.parse(body)).toEqual({ error: "not found: GET /definitely-not-a-route" });
      expect(body).not.toContain("<!doctype");
    });

    it("404s an unknown nested path rather than falling back to index.html", async () => {
      const response = await fetch(`${server.baseUrl}/villages/village-1/nope`);

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    });

    it("405s a POST to / rather than serving markup for a write", async () => {
      const response = await fetch(`${server.baseUrl}/`, { method: "POST", body: "{}" });

      expect(response.status).toBe(405);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    });
  });
});
