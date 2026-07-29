import type { Result, VillageId } from "@afrip/shared-kernel";
import type { CoordinateSource, GeoCoordinates, Village } from "../domain/village.js";

/** Outbound port: persistence for the Village aggregate. */
export interface VillageRepository {
  findById(id: VillageId): Promise<Village | null>;
  save(village: Village): Promise<void>;
  listAll(): Promise<Village[]>;
}

// ---------------------------------------------------------------------------
// Geocoding (ADR 0012 §3)
// ---------------------------------------------------------------------------
// An anti-corruption layer around a volatile third party, following the
// `SignalExtractor` precedent (ADR 0001). The application core sees only this
// port; the adapter behind it may be Nominatim, a commercial gazetteer, or a
// deterministic fake.
//
// The shape below is doing real work, so it is worth stating what it refuses to
// do. Geocoding rural Assam is unreliable — village names repeat across
// districts, transliteration varies (Rampur / Rampour / রামপুর), and many small
// chapori settlements are in no gazetteer at all (ADR 0012 §Context 1). For our
// primary geography a wrong-but-confident answer is the COMMON case, not an
// edge case. So:
//
//   * `forward` returns a ranked LIST, never a single answer. An interface that
//     hands back one result invites the caller to trust it.
//   * Nothing here produces a `GeoCoordinates`. A candidate cannot be stored,
//     assigned or passed to `Village.create` as it stands: it carries no
//     `source`. Turning one into a position takes the explicit, deliberately
//     unwieldy `confirmCandidate` below, which exists so that auto-committing a
//     geocode is something you have to mean rather than something you drift
//     into.

/** A bare point, with no claim about where it came from. */
export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/**
 * What the user has typed on the registration form so far.
 *
 * `district` is required, not optional. Biasing the query to the district
 * already on the form is the cheapest large accuracy win available (ADR 0012
 * §3), and an optional field is one every caller would omit.
 */
export interface PlaceQuery {
  /** The village name as typed. Transliteration is expected to vary. */
  readonly name: string;
  /** The district already entered on the form. */
  readonly district: string;
  /** Defaults to Assam in the adapters; present so a neighbouring state works. */
  readonly state?: string;
  /** Upper bound on candidates returned. Adapters default it. */
  readonly limit?: number;
}

/**
 * One possibility, with enough description for a human to tell
 * Rampur-in-Barpeta from Rampur-in-Sivasagar. That disambiguation is the whole
 * job — see the note above.
 */
export interface GeocodeCandidate {
  readonly lat: number;
  readonly lng: number;
  /**
   * 0..1. A heuristic, and adapters are expected to cap it below 1: for this
   * geography a geocoder is not entitled to claim certainty.
   */
  readonly confidence: number;
  /** Full human-readable address line, as the upstream gives it. */
  readonly displayName: string;
  /** Parsed out of the address where the upstream provides it. */
  readonly district?: string;
  readonly state?: string;
  /** What the upstream calls this thing: village, hamlet, town, administrative… */
  readonly kind?: string;
  /** Which adapter produced this, for attribution and for debugging a bad pin. */
  readonly provider: string;
}

/** The answer to "what is at this point?". */
export interface PlaceDescription {
  readonly displayName: string;
  readonly district?: string;
  readonly state?: string;
  readonly provider: string;
}

export interface GeocodingService {
  /**
   * Ranked candidates, best first. An empty list means "the geocoder ran and
   * found nothing" — a normal outcome for a chapori settlement. A failure to
   * reach or parse the upstream is an `err`. Adapters must not collapse the
   * second into the first: "no such village" and "the geocoder is down" must
   * not look alike to the caller.
   */
  forward(query: PlaceQuery): Promise<Result<GeocodeCandidate[]>>;
  reverse(point: LatLng): Promise<Result<PlaceDescription>>;
}

/**
 * The only way a candidate becomes a position the domain will accept.
 *
 * It is a free function rather than a method or a spread-able field on purpose.
 * `Village.create({ geo: candidate })` does not compile — the candidate has no
 * `source` — so populating coordinates from a geocode requires writing this
 * call, and this call is named for the thing that must have happened first: a
 * human confirmed the point on a map. Everything it produces is stamped
 * `geocoded`, the second-lowest trust level, which is honest about what it is:
 * a village that still needs a surveyed position (ADR 0012 §2).
 *
 * @param confirmedAt ISO instant at which the user confirmed the candidate.
 */
export function confirmCandidate(candidate: GeocodeCandidate, confirmedAt: string): GeoCoordinates {
  const source: CoordinateSource = "geocoded";
  return { lat: candidate.lat, lng: candidate.lng, source, capturedAt: confirmedAt };
}
