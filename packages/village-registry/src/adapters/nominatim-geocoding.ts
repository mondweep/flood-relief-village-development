import { err, ok, type Result } from "@afrip/shared-kernel";
import type {
  GeocodeCandidate,
  GeocodingService,
  LatLng,
  PlaceDescription,
  PlaceQuery,
} from "../application/ports.js";

/**
 * Geocoding against the public OpenStreetMap Nominatim endpoint — the zero-cost
 * adapter of ADR 0012 §3.
 *
 * ----------------------------------------------------------------------------
 * NOMINATIM'S USAGE POLICY IS NOT ADVISORY. READ THIS BEFORE CHANGING ANYTHING.
 * ----------------------------------------------------------------------------
 * The public endpoint is run on donated hardware for the OSM community, and it
 * is enforced. Two rules matter here and both are implemented below rather than
 * documented and hoped for:
 *
 *   1. Every request MUST carry a User-Agent identifying this application, with
 *      a contact address. Requests with a generic or absent User-Agent are
 *      refused outright. There is deliberately NO default value for it in this
 *      class — a default would end up shipping as somebody else's identity.
 *   2. At most ONE request per second, absolute, across the whole application.
 *      Not per user, not per page. Bursting is the fastest way to get the
 *      server's IP banned, and a ban lands on the deployment, not on the
 *      developer who wrote the loop.
 *
 * Breaking either of these gets our IP blocked, at which point the feature is
 * dead for every field worker at once and there is no self-service appeal. If a
 * higher throughput is genuinely needed, the answer is a self-hosted Nominatim
 * or a commercial gazetteer behind the same port — not a smaller sleep.
 *
 * Attribution: results are © OpenStreetMap contributors (ODbL) and any UI
 * showing them must say so.
 */

const DEFAULT_BASE_URL = "https://nominatim.openstreetmap.org";
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const DEFAULT_LIMIT = 5;
const PROVIDER = "nominatim";

/**
 * Assam's rough bounding box, used to BIAS the search (not to bound it — a
 * hard bound would drop a village whose gazetteer entry sits just outside).
 * Order is Nominatim's: left, top, right, bottom.
 */
const ASSAM_VIEWBOX = "89.6,28.3,96.1,24.1";
const DEFAULT_STATE = "Assam";

/** Minimal slice of the fetch API, so this file needs no DOM lib and stubs cleanly. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { readonly headers: Record<string, string> },
) => Promise<FetchResponse>;

export interface NominatimGeocodingOptions {
  /**
   * Required. Something like
   * `"AFRIP/0.1 (flood-relief platform; ops@example.org)"`. See the policy note
   * above: no default is offered on purpose.
   */
  readonly userAgent: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  /** Defaults to 1000 ms. Lowering it violates the usage policy. */
  readonly minIntervalMs?: number;
  /** Injected for tests, which must not actually wait a second per request. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface NominatimAddress {
  readonly state_district?: unknown;
  readonly county?: unknown;
  readonly district?: unknown;
  readonly state?: unknown;
}

interface NominatimPlace {
  readonly lat?: unknown;
  readonly lon?: unknown;
  readonly display_name?: unknown;
  readonly importance?: unknown;
  readonly addresstype?: unknown;
  readonly type?: unknown;
  readonly address?: NominatimAddress;
}

function defaultFetch(): FetchLike | null {
  // `fetch` is a Node 18+ global; typed loosely here because this package
  // compiles with `lib: ES2022` and no DOM.
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as unknown as FetchLike) : null;
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Nominatim reports lat/lon as strings; anything else means we misread the format. */
function coordinate(value: unknown, min: number, max: number): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function normalise(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function addressDistrict(address: NominatimAddress | undefined): string | undefined {
  if (!address) return undefined;
  return text(address.state_district) ?? text(address.district) ?? text(address.county);
}

/**
 * Confidence is a heuristic, and it is capped below 1 on purpose: for rural
 * Assam this geocoder is frequently wrong (ADR 0012 §Context 1), and a number
 * that can read 1.0 is a number a UI will eventually treat as "safe to accept".
 */
const MAX_CONFIDENCE = 0.9;

function confidenceOf(place: NominatimPlace, query: PlaceQuery, district: string | undefined): number {
  const importance = typeof place.importance === "number" ? place.importance : 0;
  const displayName = text(place.display_name) ?? "";
  const districtMatches = district !== undefined && normalise(district) === normalise(query.district);
  const nameMatches = normalise(displayName).startsWith(normalise(query.name));

  const score =
    0.3 + (districtMatches ? 0.3 : 0) + (nameMatches ? 0.15 : 0) + Math.min(Math.max(importance, 0), 1) * 0.25;
  return Math.round(Math.min(score, MAX_CONFIDENCE) * 100) / 100;
}

export class NominatimGeocoding implements GeocodingService {
  private readonly userAgent: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  /** Serialises every request through one chain — see rule 2 in the header. */
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(options: NominatimGeocodingOptions) {
    if (options.userAgent.trim().length === 0) {
      throw new Error(
        "NominatimGeocoding requires an identifying User-Agent: Nominatim's usage policy refuses anonymous requests",
      );
    }
    const fetchImpl = options.fetch ?? defaultFetch();
    if (!fetchImpl) throw new Error("NominatimGeocoding requires a fetch implementation");

    this.userAgent = options.userAgent;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.sleep = options.sleep ?? sleepFor;
    this.now = options.now ?? Date.now;
  }

  async forward(query: PlaceQuery): Promise<Result<GeocodeCandidate[]>> {
    if (query.name.trim().length === 0) return err("name must not be empty");
    if (query.district.trim().length === 0) return err("district must not be empty");

    const state = query.state ?? DEFAULT_STATE;
    const params = new URLSearchParams({
      // Free-form rather than structured: Nominatim's structured query has no
      // `village` field, and for a settlement absent from the address hierarchy
      // the free-form index is the one that has any chance of a hit at all.
      q: `${query.name}, ${query.district}, ${state}, India`,
      format: "jsonv2",
      addressdetails: "1",
      countrycodes: "in",
      viewbox: ASSAM_VIEWBOX,
      limit: String(query.limit ?? DEFAULT_LIMIT),
    });

    const body = await this.request(`${this.baseUrl}/search?${params.toString()}`);
    if (!body.ok) return err(body.error);

    if (!Array.isArray(body.value)) {
      return err("nominatim returned a malformed body: expected an array of places");
    }

    const candidates: GeocodeCandidate[] = [];
    for (const [index, entry] of body.value.entries()) {
      if (typeof entry !== "object" || entry === null) {
        return err(`nominatim returned a malformed body: place ${index} is not an object`);
      }
      const place = entry as NominatimPlace;
      const lat = coordinate(place.lat, -90, 90);
      const lng = coordinate(place.lon, -180, 180);
      if (lat === null || lng === null) {
        return err(`nominatim returned a malformed body: place ${index} has no usable lat/lon`);
      }

      const district = addressDistrict(place.address);
      const placeState = text(place.address?.state);

      // Filtering by the district already on the form is the cheapest large
      // accuracy win available (ADR 0012 §3). It is applied only when the
      // upstream actually reports a district: many chapori settlements come
      // back with a sparse address, and discarding those would throw away the
      // very results this geography most needs.
      if (district !== undefined && normalise(district) !== normalise(query.district)) continue;
      if (placeState !== undefined && normalise(placeState) !== normalise(state)) continue;

      candidates.push({
        lat,
        lng,
        confidence: confidenceOf(place, query, district),
        displayName: text(place.display_name) ?? `${query.name}, ${query.district}`,
        ...(district === undefined ? {} : { district }),
        ...(placeState === undefined ? {} : { state: placeState }),
        ...(text(place.addresstype) ?? text(place.type)
          ? { kind: (text(place.addresstype) ?? text(place.type)) as string }
          : {}),
        provider: PROVIDER,
      });
    }

    // Best first. An empty list here means Nominatim answered and had nothing —
    // which for a chapori settlement is the expected answer, and is emphatically
    // NOT what a transport or parse failure returns.
    candidates.sort((a, b) => b.confidence - a.confidence);
    return ok(candidates);
  }

  async reverse(point: LatLng): Promise<Result<PlaceDescription>> {
    if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
      return err("lat must be between -90 and 90");
    }
    if (!Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
      return err("lng must be between -180 and 180");
    }

    const params = new URLSearchParams({
      lat: String(point.lat),
      lon: String(point.lng),
      format: "jsonv2",
      addressdetails: "1",
    });

    const body = await this.request(`${this.baseUrl}/reverse?${params.toString()}`);
    if (!body.ok) return err(body.error);

    if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
      return err("nominatim returned a malformed body: expected an object");
    }
    const place = body.value as NominatimPlace & { error?: unknown };
    // Nominatim's own "nothing here" shape. Distinct message from a transport
    // failure: the sea is not an outage.
    if (place.error !== undefined) return err("nominatim found no place at that point");

    const displayName = text(place.display_name);
    if (displayName === undefined) {
      return err("nominatim returned a malformed body: reverse result has no display_name");
    }
    const district = addressDistrict(place.address);
    const state = text(place.address?.state);
    return ok({
      displayName,
      ...(district === undefined ? {} : { district }),
      ...(state === undefined ? {} : { state }),
      provider: PROVIDER,
    });
  }

  /**
   * One request, rate-limited and parsed. Every failure path returns `err`:
   * a non-200, an unparseable body and a thrown fetch all become values, so no
   * caller of the port has to wrap it in a try/catch to be safe.
   */
  private async request(url: string): Promise<Result<unknown>> {
    await this.throttle();

    let response: FetchResponse;
    try {
      response = await this.fetchImpl(url, {
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
      });
    } catch (cause) {
      return err(`nominatim request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    if (!response.ok) {
      // Deliberately NOT `ok([])`. A 500 or a 429 means we do not know whether
      // the village exists, and reporting "no results" for an outage is how a
      // registry quietly fills with villages marked as unfindable.
      return err(`nominatim responded ${response.status}`);
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (cause) {
      return err(`nominatim request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    try {
      return ok(JSON.parse(raw));
    } catch {
      return err("nominatim returned a malformed body: not JSON");
    }
  }

  /** Holds requests to one per `minIntervalMs`, globally, in arrival order. */
  private async throttle(): Promise<void> {
    const turn = this.gate.then(async () => {
      const wait = this.minIntervalMs - (this.now() - this.lastRequestAt);
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
    });
    this.gate = turn.catch(() => undefined);
    return turn;
  }
}
