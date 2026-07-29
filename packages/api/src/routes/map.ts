import leafletCss from "../../../web/vendor/leaflet-1.9.4.css.txt";
import leafletJs from "../../../web/vendor/leaflet-1.9.4.js.txt";
import { badRequest, bytes, json, notFound, type HttpResponse } from "../http-result.js";
import type { RequestContext, Router } from "../router.js";
import type { RouteDeps } from "./deps.js";

/**
 * Map tile proxy (ADR 0012 §4).
 *
 * The browser fetches tiles from THIS origin, never from a tile host directly.
 * Three reasons, in the order they matter:
 *
 *  1. PRIVACY. A tile request reveals where the requester is looking. Fetched
 *     directly, the tile host would receive the map session of every field
 *     worker — which villages, at which zoom, from which IP — and those
 *     coordinates locate flood-affected settlements and, through the beneficiary
 *     registry, vulnerable people. Proxied, the host sees Cloud Run.
 *  2. The page has no external references by design, so its Content-Security
 *     -Policy can stay closed. A tile URL pointing elsewhere would be the first
 *     hole in it.
 *  3. Caching. Repeat views cost nothing on a poor connection.
 *
 * The cost is ours: bandwidth, a cache to evict, and responsibility for the
 * upstream's usage policy and attribution, which are NOT optional. See
 * ATTRIBUTION below.
 */

/**
 * OpenStreetMap's standard tile layer. Its usage policy requires an identifying
 * User-Agent, forbids bulk downloading, and expects caching — all honoured
 * below. Read https://operations.osmfoundation.org/policies/tiles/ before
 * changing anything here; a violation gets the deployment's IP blocked, and the
 * symptom is every map silently going blank.
 */
const UPSTREAM = "https://tile.openstreetmap.org";

/**
 * Shared with the Nominatim geocoding adapter (see persistence.ts). Both are
 * OpenStreetMap Foundation services, both identify callers by User-Agent, and
 * both ban by IP — so one identity string and one contact point for the pair.
 */
export const OSM_USER_AGENT =
  "AFRIP/0.1 (flood recovery platform; https://github.com/mondweep/flood-relief-village-development)";

/**
 * ATTRIBUTION. OSM's licence (ODbL) requires visible credit wherever tiles are
 * shown. The frontend renders this next to every map; it is defined here, beside
 * the thing it credits, so the two cannot drift apart.
 */
export const TILE_ATTRIBUTION = "© OpenStreetMap contributors";

/**
 * Zoom bounds. Below 5 a tile spans most of a subcontinent and is useless here;
 * above 18 OSM has no data for rural Assam and every request is a miss the
 * upstream still has to serve.
 */
const MIN_ZOOM = 5;
const MAX_ZOOM = 18;

/**
 * Assam and a generous margin: roughly 88°E–98°E, 23°N–29°N, which covers the
 * whole state, the Brahmaputra valley and enough of the neighbouring states that
 * a map can be panned without hitting a wall.
 *
 * THIS IS A SECURITY CONTROL, not a nicety, and it is the reason the route can
 * safely be public. Tiles cannot carry an Authorization header — Leaflet loads
 * them through `<img src>` — so this endpoint is reachable by anyone who finds
 * it. Unbounded, that makes us a free tile relay for the whole world at our
 * bandwidth cost, and gets our IP banned by OSM for exactly the bulk-download
 * behaviour their policy forbids. Bounded to one Indian state, we are useless to
 * anyone but this platform.
 */
const BOUNDS = { minLon: 88, maxLon: 98, minLat: 23, maxLat: 29 } as const;

/** Tile x/y at a zoom to the lon/lat of its north-west corner (the standard slippy formulae). */
function tileNorthWest(z: number, x: number, y: number): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: (latRad * 180) / Math.PI };
}

/** True when a tile overlaps the served region. Checks the tile's own extent, not a point. */
function withinBounds(z: number, x: number, y: number): boolean {
  const nw = tileNorthWest(z, x, y);
  const se = tileNorthWest(z, x + 1, y + 1);
  return (
    se.lon >= BOUNDS.minLon && nw.lon <= BOUNDS.maxLon && se.lat <= BOUNDS.maxLat && nw.lat >= BOUNDS.minLat
  );
}

function parseTileCoord(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  // Strictly digits. `parseInt` would accept "5abc" and "0x10"; a coordinate
  // that is nearly a number is a coordinate somebody is probing with.
  if (!/^\d{1,3}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

interface CachedTile {
  readonly body: Buffer;
  readonly contentType: string;
  readonly storedAt: number;
}

/**
 * A bounded in-memory tile cache.
 *
 * Deliberately not durable and deliberately small. Cloud Run scales to zero, so
 * this is cold on the first request of a session and that is accepted — the win
 * is within a session, where a user pans over the same tiles repeatedly. A
 * persistent cache would mean a storage bucket and an eviction job, which is
 * more machinery than the traffic justifies.
 *
 * Insertion-ordered eviction (`Map` preserves it), refreshed on read, so the
 * least recently used tile goes first.
 */
class TileCache {
  private readonly entries = new Map<string, CachedTile>();

  constructor(
    private readonly maxEntries = 512,
    private readonly ttlMs = 7 * 24 * 60 * 60 * 1000,
  ) {}

  get(key: string, now: number): CachedTile | null {
    const hit = this.entries.get(key);
    if (hit === undefined) return null;
    if (now - hit.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    // Re-insert so this becomes the most recently used.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, tile: CachedTile): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, tile);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface MapRouteOptions {
  /** Test seam: a stubbed fetch, so no test reaches the internet. */
  readonly fetchTile?: typeof fetch;
  readonly cache?: TileCache;
  readonly now?: () => number;
}

export { TileCache };

/** Leaflet's version, surfaced so the page can log what it loaded. */
export const LEAFLET_VERSION = "1.9.4";

/**
 * A year, immutable. These two routes serve a PINNED version from the bundle, so
 * the bytes at a given URL cannot change without a redeploy — which is exactly
 * the condition under which a long cache is safe. `immutable` stops a phone on a
 * poor connection revalidating 147 KB it already has.
 */
const VENDOR_CACHE = "public, max-age=31536000, immutable";

export function registerMapRoutes(router: Router, _deps: RouteDeps, options: MapRouteOptions = {}): void {
  const fetchTile = options.fetchTile ?? fetch;

  /**
   * The map library, from our own origin (ADR 0012 §4).
   *
   * PUBLIC, like the tiles, and for the same unavoidable reason: these are loaded
   * by `<script>` and `<link>`, which cannot carry an Authorization header. The
   * exposure is nil — it is a BSD-licensed library anyone can download from
   * unpkg — and the reason it is served here rather than linked there is that a
   * CDN would put a third party in the page's supply chain and in its CSP.
   *
   * `@preserve` in Leaflet's own header carries the copyright notice its BSD
   * 2-Clause licence requires; the full licence text is checked in beside the
   * file at packages/web/vendor/leaflet-1.9.4.LICENSE.txt. Do not minify these
   * further or strip comments — that notice must survive.
   */
  router.get("/map/leaflet.js", async (): Promise<HttpResponse> => ({
    status: 200,
    body: leafletJs,
    raw: true,
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": VENDOR_CACHE },
  }));

  router.get("/map/leaflet.css", async (): Promise<HttpResponse> => ({
    status: 200,
    body: leafletCss,
    raw: true,
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": VENDOR_CACHE },
  }));
  const cache = options.cache ?? new TileCache();
  const now = options.now ?? (() => Date.now());

  /**
   * Serves one tile. PUBLIC — see the note on BOUNDS for why that is acceptable
   * and what makes it so. `isPublicPath` in auth.ts must list `/map/` for this
   * to be reachable at all.
   */
  router.get("/map/tiles/:z/:x/:y", async (ctx: RequestContext): Promise<HttpResponse> => {
    const z = parseTileCoord(ctx.params["z"]);
    const x = parseTileCoord(ctx.params["x"]);
    // Leaflet requests `…/{y}.png`; the router hands us the last segment whole.
    const y = parseTileCoord((ctx.params["y"] ?? "").replace(/\.png$/i, ""));

    if (z === null || x === null || y === null) return badRequest("tile coordinates must be integers");
    if (z < MIN_ZOOM || z > MAX_ZOOM) {
      return badRequest(`zoom must be between ${MIN_ZOOM} and ${MAX_ZOOM}`);
    }
    const limit = 2 ** z;
    if (x >= limit || y >= limit) return badRequest("tile coordinates are outside the zoom level");
    if (!withinBounds(z, x, y)) {
      // 404 rather than 403: the tile is not served here, which is a fact about
      // this endpoint, not a statement about the caller's permissions.
      return notFound("this proxy serves tiles for Assam only");
    }

    const key = `${z}/${x}/${y}`;
    const cached = cache.get(key, now());
    if (cached !== null) {
      return bytes(200, cached.body, {
        "content-type": cached.contentType,
        "cache-control": "public, max-age=604800",
        "x-tile-cache": "hit",
        "x-tile-attribution": TILE_ATTRIBUTION,
      });
    }

    let upstream: Response;
    try {
      upstream = await fetchTile(`${UPSTREAM}/${key}.png`, {
        headers: { "user-agent": OSM_USER_AGENT, accept: "image/png,image/*" },
      });
    } catch (error) {
      // The map degrades rather than the page breaking: Leaflet shows a blank
      // tile for a failed request, which is the right outcome when the upstream
      // is unreachable and the user is mid-form.
      console.error(`[api] tile fetch failed for ${key}: ${String(error)}`);
      return json(502, { error: "the map tile service could not be reached" });
    }

    if (!upstream.ok) {
      console.error(`[api] tile upstream returned ${upstream.status} for ${key}`);
      return json(502, { error: `the map tile service returned ${upstream.status}` });
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type") ?? "image/png";
    cache.set(key, { body, contentType, storedAt: now() });

    return bytes(200, body, {
      "content-type": contentType,
      "cache-control": "public, max-age=604800",
      "x-tile-cache": "miss",
      "x-tile-attribution": TILE_ATTRIBUTION,
    });
  });
}
