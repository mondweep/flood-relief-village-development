import { err, ok, type Result } from "@afrip/shared-kernel";
import type {
  GeocodeCandidate,
  GeocodingService,
  LatLng,
  PlaceDescription,
  PlaceQuery,
} from "../application/ports.js";

/**
 * A deterministic `GeocodingService` over a fixed table of places.
 *
 * Two jobs, both real:
 *  - tests, which must never reach the network (a test that calls the live
 *    Nominatim fails on a plane, and rate-limits the deployment besides);
 *  - a deployment with no geocoder configured, where this is the honest default:
 *    it answers from a small known table and says "nothing found" for everything
 *    else, rather than pretending the feature is unavailable.
 *
 * Deterministic in the strict sense: same table plus same query gives the same
 * candidates in the same order with the same confidences, for ever. No clock,
 * no randomness, no network.
 */

const PROVIDER = "fake";

export interface FakePlace {
  readonly name: string;
  readonly district: string;
  readonly lat: number;
  readonly lng: number;
  readonly state?: string;
  readonly kind?: string;
}

/**
 * A handful of real Assam districts, plus the case ADR 0012 §Context 1 names
 * outright: two villages called Rampur in different districts, which is exactly
 * the ambiguity a single-answer geocoder resolves by guessing.
 */
export const DEFAULT_FAKE_PLACES: readonly FakePlace[] = [
  { name: "Rampur", district: "Barpeta", lat: 26.3223, lng: 90.9871, kind: "village" },
  { name: "Rampur", district: "Sivasagar", lat: 26.9826, lng: 94.6377, kind: "village" },
  { name: "Majuli", district: "Majuli", lat: 26.9509, lng: 94.1682, kind: "island" },
  { name: "Dhemaji", district: "Dhemaji", lat: 27.4833, lng: 94.5833, kind: "town" },
  { name: "Jaha Chapori", district: "Dhemaji", lat: 27.3901, lng: 94.4102, kind: "hamlet" },
  { name: "Kalgachia", district: "Barpeta", lat: 26.3667, lng: 90.9833, kind: "village" },
];

const DEFAULT_STATE = "Assam";
const DEFAULT_LIMIT = 5;

/** Same normalisation the Nominatim adapter uses: transliteration varies. */
function normalise(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Fixed confidences, chosen to mirror the real adapter's shape rather than its
 * arithmetic: an exact name in the right district beats a partial name, and
 * nothing ever reaches 1.0 — for this geography a geocoder is not entitled to
 * claim certainty.
 */
const EXACT_IN_DISTRICT = 0.9;
const PARTIAL_IN_DISTRICT = 0.6;

/** Metres per degree of latitude, near enough for "which of these is closest". */
const DEGREE_METRES = 111_320;
const REVERSE_RADIUS_METRES = 25_000;

function distanceMetres(a: LatLng, b: LatLng): number {
  const dLat = (a.lat - b.lat) * DEGREE_METRES;
  const dLng = (a.lng - b.lng) * DEGREE_METRES * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

export class FakeGeocoding implements GeocodingService {
  constructor(private readonly places: readonly FakePlace[] = DEFAULT_FAKE_PLACES) {}

  async forward(query: PlaceQuery): Promise<Result<GeocodeCandidate[]>> {
    if (query.name.trim().length === 0) return err("name must not be empty");
    if (query.district.trim().length === 0) return err("district must not be empty");

    const state = query.state ?? DEFAULT_STATE;
    const wantedName = normalise(query.name);
    const wantedDistrict = normalise(query.district);

    const candidates: GeocodeCandidate[] = [];
    for (const place of this.places) {
      if (normalise(place.state ?? DEFAULT_STATE) !== normalise(state)) continue;
      // District filtering, as ADR 0012 §3 requires: the Rampur in Sivasagar is
      // simply not a candidate when the form already says Barpeta.
      if (normalise(place.district) !== wantedDistrict) continue;

      const placeName = normalise(place.name);
      const exact = placeName === wantedName;
      if (!exact && !placeName.includes(wantedName)) continue;

      candidates.push({
        lat: place.lat,
        lng: place.lng,
        confidence: exact ? EXACT_IN_DISTRICT : PARTIAL_IN_DISTRICT,
        displayName: `${place.name}, ${place.district}, ${place.state ?? DEFAULT_STATE}, India`,
        district: place.district,
        state: place.state ?? DEFAULT_STATE,
        ...(place.kind === undefined ? {} : { kind: place.kind }),
        provider: PROVIDER,
      });
    }

    // An empty list is a legitimate answer, not a failure: most chapori
    // settlements are in no gazetteer at all (ADR 0012 §Context 1).
    candidates.sort((a, b) => b.confidence - a.confidence || a.displayName.localeCompare(b.displayName));
    return ok(candidates.slice(0, query.limit ?? DEFAULT_LIMIT));
  }

  async reverse(point: LatLng): Promise<Result<PlaceDescription>> {
    if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
      return err("lat must be between -90 and 90");
    }
    if (!Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
      return err("lng must be between -180 and 180");
    }

    let nearest: FakePlace | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const place of this.places) {
      const distance = distanceMetres(point, place);
      if (distance < nearestDistance) {
        nearest = place;
        nearestDistance = distance;
      }
    }

    if (!nearest || nearestDistance > REVERSE_RADIUS_METRES) {
      return err("no known place near that point");
    }

    return ok({
      displayName: `${nearest.name}, ${nearest.district}, ${nearest.state ?? DEFAULT_STATE}, India`,
      district: nearest.district,
      state: nearest.state ?? DEFAULT_STATE,
      provider: PROVIDER,
    });
  }
}
