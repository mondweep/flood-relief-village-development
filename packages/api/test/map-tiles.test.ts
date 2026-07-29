import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicPath } from "../src/auth.js";
import { Router } from "../src/router.js";
import { registerMapRoutes, TileCache, TILE_ATTRIBUTION } from "../src/routes/map.js";
import { startTestServerWith, testConfig, type TestServer } from "./helpers.js";
import { createMemoryRuntime } from "../src/persistence.js";

/**
 * The tile proxy (ADR 0012 §4).
 *
 * The interesting tests here are the refusals, not the happy path. This route is
 * PUBLIC — Leaflet loads tiles through `<img src>`, which cannot carry an
 * Authorization header — so the only thing standing between it and being a free
 * tile relay for the internet is the geographic bound. That bound is a security
 * control, and it is tested as one.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);

function stubFetch(body: Buffer = PNG, init: { status?: number; type?: string } = {}) {
  return vi.fn(async () =>
    new Response(new Uint8Array(body), {
      status: init.status ?? 200,
      headers: { "content-type": init.type ?? "image/png" },
    }),
  ) as unknown as typeof fetch;
}

function build(fetchTile: typeof fetch, cache?: TileCache) {
  const router = new Router();
  const deps = { config: testConfig(), runtime: createMemoryRuntime() };
  registerMapRoutes(router, deps, { fetchTile, ...(cache ? { cache } : {}) });
  return async (path: string) => {
    const match = router.match("GET", path);
    if (match === null) return { status: 404, body: { error: "no route" } };
    return match.handler({
      method: "GET",
      path,
      params: match.params,
      query: new URLSearchParams(),
      body: undefined,
      actor: null,
      platform: deps.runtime.platform,
      requestId: "req-test",
    });
  };
}

/**
 * Real tile coordinates, computed from the standard slippy formulae rather than
 * guessed — an earlier version of this file used invented numbers, and every
 * "inside Assam" case 404'd while looking like a bounds bug.
 */
const IN_ASSAM = "/map/tiles/10/772/434";           // Guwahati

describe("the tile proxy serves Assam", () => {
  it("returns the upstream bytes unchanged", async () => {
    const fetchTile = stubFetch();
    const response = await build(fetchTile)(IN_ASSAM);

    expect(response.status).toBe(200);
    expect(Buffer.isBuffer(response.body)).toBe(true);
    // Byte-for-byte. A String() round trip would mangle the PNG signature, and
    // the corruption is invisible until an image fails to decode in a browser.
    expect((response.body as Buffer).equals(PNG)).toBe(true);
    expect(response.headers?.["content-type"]).toBe("image/png");
  });

  it("identifies itself upstream, as OSM's usage policy requires", async () => {
    const fetchTile = stubFetch();
    await build(fetchTile)(IN_ASSAM);

    const [, init] = (fetchTile as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    // A missing or generic User-Agent gets the deployment's IP blocked, and the
    // symptom is every map silently going blank.
    expect(init.headers["user-agent"]).toMatch(/AFRIP/);
  });

  /**
   * The villages this platform exists for. Upper Assam is the eastern edge of
   * the served box, so it is the part most likely to be cut off by a careless
   * tightening of BOUNDS — which would break the map precisely where the July
   * 2026 floods were.
   */
  it.each([
    ["Dibrugarh", "/map/tiles/10/781/430"],
    ["Sivasagar", "/map/tiles/10/781/432"],
    ["Majuli", "/map/tiles/10/779/432"],
    ["Barpeta", "/map/tiles/10/770/434"],
  ])("serves %s, in Upper Assam", async (_place, path) => {
    const response = await build(stubFetch())(path);
    expect(response.status).toBe(200);
  });

  it("credits OpenStreetMap, which the licence requires wherever tiles are shown", async () => {
    const response = await build(stubFetch())(IN_ASSAM);
    expect(response.headers?.["x-tile-attribution"]).toBe(TILE_ATTRIBUTION);
    expect(TILE_ATTRIBUTION).toMatch(/OpenStreetMap/);
  });
});

describe("the tile proxy refuses to be a general-purpose relay", () => {
  /**
   * The one that matters. Without this bound the route is an open tile proxy at
   * our bandwidth cost, and bulk-serving the world is exactly what gets an IP
   * banned by OSM.
   */
  it.each([
    ["London", "/map/tiles/10/511/340"],
    ["New York", "/map/tiles/10/301/385"],
    ["Delhi", "/map/tiles/10/731/427"],
    ["Mumbai", "/map/tiles/10/719/456"],
    ["Beijing", "/map/tiles/10/843/388"],
  ])("refuses a tile for %s", async (_place, path) => {
    const fetchTile = stubFetch();
    const response = await build(fetchTile)(path);

    expect(response.status).toBe(404);
    // And crucially never reaches upstream — a refusal that still costs a fetch
    // would leave the bandwidth and the ban risk exactly where they were.
    expect(fetchTile).not.toHaveBeenCalled();
  });

  it("refuses zoom levels outside the served range", async () => {
    const fetchTile = stubFetch();
    const request = build(fetchTile);

    expect((await request("/map/tiles/2/1/1")).status).toBe(400);
    expect((await request("/map/tiles/19/1/1")).status).toBe(400);
    expect(fetchTile).not.toHaveBeenCalled();
  });

  it.each(["/map/tiles/a/1/1", "/map/tiles/10/-1/1", "/map/tiles/10/0x10/1", "/map/tiles/10/1/1e3"])(
    "refuses a non-integer coordinate: %s",
    async (path) => {
      const fetchTile = stubFetch();
      const response = await build(fetchTile)(path);
      expect([400, 404]).toContain(response.status);
      expect(fetchTile).not.toHaveBeenCalled();
    },
  );

  it("refuses coordinates beyond the grid at that zoom", async () => {
    const fetchTile = stubFetch();
    // Zoom 10 has 1024 tiles per axis, so 1024 is one past the end.
    const response = await build(fetchTile)("/map/tiles/10/1024/434");
    expect(response.status).toBe(400);
    expect(fetchTile).not.toHaveBeenCalled();
  });
});

describe("caching", () => {
  it("serves a repeat request from cache without touching upstream", async () => {
    const fetchTile = stubFetch();
    const request = build(fetchTile, new TileCache());

    const first = await request(IN_ASSAM);
    const second = await request(IN_ASSAM);

    expect(first.headers?.["x-tile-cache"]).toBe("miss");
    expect(second.headers?.["x-tile-cache"]).toBe("hit");
    expect(fetchTile).toHaveBeenCalledTimes(1);
    expect((second.body as Buffer).equals(PNG)).toBe(true);
  });

  it("evicts the least recently used tile rather than growing without bound", async () => {
    const cache = new TileCache(2);
    cache.set("a", { body: PNG, contentType: "image/png", storedAt: 0 });
    cache.set("b", { body: PNG, contentType: "image/png", storedAt: 0 });
    cache.get("a", 1); // 'a' is now the most recently used, so 'b' should go
    cache.set("c", { body: PNG, contentType: "image/png", storedAt: 0 });

    expect(cache.size).toBe(2);
    expect(cache.get("a", 2)).not.toBeNull();
    expect(cache.get("b", 2)).toBeNull();
    expect(cache.get("c", 2)).not.toBeNull();
  });

  it("treats an expired entry as absent", async () => {
    const cache = new TileCache(10, 1000);
    cache.set("a", { body: PNG, contentType: "image/png", storedAt: 0 });
    expect(cache.get("a", 500)).not.toBeNull();
    expect(cache.get("a", 5000)).toBeNull();
  });
});

describe("upstream failures degrade the map, not the page", () => {
  it("reports a 502 when the tile service errors", async () => {
    const response = await build(stubFetch(PNG, { status: 500 }))(IN_ASSAM);
    expect(response.status).toBe(502);
  });

  it("reports a 502 when the tile service is unreachable", async () => {
    const fetchTile = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const response = await build(fetchTile)(IN_ASSAM);
    expect(response.status).toBe(502);
  });

  it("does not cache a failure", async () => {
    const cache = new TileCache();
    const failing = stubFetch(PNG, { status: 500 });
    await build(failing, cache)(IN_ASSAM);
    expect(cache.size).toBe(0);
  });
});

/**
 * Over the wire, through the real server.
 *
 * The handler-level test above asserts the response body is a Buffer, and that
 * is NOT enough: the corruption this guards against happens in `writeResponse`,
 * where a non-binary path would run `String(buffer)` and decode the bytes as
 * UTF-8. A mutation removing the binary branch left every handler-level test
 * green, which is how this suite came to exist.
 */
describe("tiles survive the write path", () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  it("delivers the exact bytes to an HTTP client", async () => {
    server = await startTestServerWith({
      config: testConfig(),
      runtime: createMemoryRuntime(),
      fetchTile: stubFetch(),
    });

    const response = await fetch(`${server.baseUrl}${IN_ASSAM}`);
    const received = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    // The PNG signature is 0x89 'P' 'N' 'G' — the leading 0x89 is not valid
    // UTF-8 on its own, so a string round trip replaces it with U+FFFD and the
    // length changes. Comparing bytes catches exactly that.
    expect(received.length).toBe(PNG.length);
    expect(received.equals(PNG)).toBe(true);
    expect(received[0]).toBe(0x89);
  });

  it("serves tiles without any credential", async () => {
    server = await startTestServerWith({
      config: testConfig({ apiToken: "a-real-token" }),
      runtime: createMemoryRuntime(),
      fetchTile: stubFetch(),
    });

    // No Authorization header at all — an <img> cannot send one.
    const response = await fetch(`${server.baseUrl}${IN_ASSAM}`);
    expect(response.status).toBe(200);
  });
});

describe("the auth gate", () => {
  /**
   * Public of necessity: an `<img src>` cannot send a bearer token. If this ever
   * stops being public, every map silently goes blank — which is why it is
   * asserted rather than left to the gate's default.
   */
  it("treats tile paths as public", () => {
    expect(isPublicPath("/map/tiles/10/730/442")).toBe(true);
    expect(isPublicPath("/map/tiles/10/730/442.png")).toBe(true);
  });

  it("does not make anything else under /map public", () => {
    expect(isPublicPath("/map")).toBe(false);
    expect(isPublicPath("/map/config")).toBe(false);
  });
});
