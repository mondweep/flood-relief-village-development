# ADR 0012 — Location capture: GPS, map pin or geocode, with provenance recorded

**Status:** Proposed

## Context

Registering a village currently requires typing `lat` and `lng` as decimal numbers into a form.
Nobody knows their village's decimal coordinates. In practice this guarantees one of three
outcomes: the field is left to a colleague with a laptop, it is filled with a district centroid
copied between rows, or it is wrong. `Village.create` validates only that the numbers fall in
`[-90, 90]` and `[-180, 180]`, so a plausible-looking wrong coordinate passes silently and the
disaster map — the platform's first module in the PRD — is quietly built on it.

Three capture methods are wanted: a mapping service filling coordinates from the village name,
device GPS for staff standing in the village, and picking a point on a map.

Four constraints shape the design:

1. **Geocoding rural Assam is unreliable.** Village names repeat across districts, transliteration
   varies (Rampur / Rampour / রামপুর), and many small chapori settlements are absent from every
   commercial gazetteer. A geocoder will frequently return the wrong village confidently, or a
   district centroid, or nothing. This is not an edge case to handle — for our primary geography it
   is the common case.
2. **The frontend is a single self-contained file with no external references.** A map needs tiles,
   and tiles come from a server. This feature cannot be built without confronting that constraint
   directly.
3. **The PRD wants offline capability** for field use. Device GPS works without a network; tiles
   and geocoding do not.
4. **Coordinates here are sensitive.** They locate flood-affected settlements and, through the
   beneficiary registry, vulnerable people. Where those requests go is a privacy decision, not
   only a technical one.

## Decision

### 1. Coordinate provenance becomes part of the domain model

This is the central decision, and it reframes the request. A GPS fix taken standing in a village
and a geocoder's guess from a name are both "a latitude and a longitude", and the current model
cannot tell them apart. That difference is domain-meaningful: a district officer deciding where to
send a boat needs to know which positions are surveyed and which are inferred.

`GeoCoordinates` is extended (not replaced) with how the position was obtained:

```ts
export type CoordinateSource = "device_gps" | "map_pin" | "geocoded" | "manual_entry";

export interface GeoCoordinates {
  readonly lat: number;
  readonly lng: number;
  readonly source: CoordinateSource;
  readonly accuracyMetres?: number;   // device GPS reports this; others do not
  readonly capturedAt?: string;       // ISO instant
}
```

Trust ordering, highest first: `device_gps` → `map_pin` → `geocoded` → `manual_entry`. The
registry can then answer "which villages still need a surveyed position?", which is a real
operational question the platform currently cannot express.

`source` is **required**. An optional provenance field would default to absent for every existing
row and every lazy caller, which is precisely the ambiguity this decision exists to remove. The
existing three seeded villages migrate to `manual_entry`, which is what they honestly are.

### 2. Coordinates stay required, but low-confidence values are explicit

The tempting alternative — make `geo` nullable so a village can be registered without a position —
is rejected. A null coordinate spreads a branch through every consumer, and in practice nobody
returns to fill it in. Instead, registration may proceed with a `geocoded` or `manual_entry`
position, and the UI surfaces those as **unverified, pending survey**. The record is complete; its
confidence is visible.

### 3. Geocoding sits behind a port, like every other volatile third party

Following the `SignalExtractor` precedent (ADR 0001's anti-corruption rule):

```ts
export interface GeocodingService {
  forward(query: PlaceQuery): Promise<Result<GeocodeCandidate[]>>;
  reverse(point: LatLng): Promise<Result<PlaceDescription>>;
}
```

- **Returns candidates, never a single answer.** Given constraint 1, a geocoder that returns one
  result invites the caller to trust it. Returning a ranked list with confidence forces the
  interface — and the user — to choose.
- Queries are biased to Assam and filtered by the district already entered on the form, which is
  the cheapest large accuracy win available.
- Adapters: a Google Geocoding adapter (the project already has GCP billing and IAM, so this adds
  no vendor), a Nominatim adapter as the zero-cost alternative, and a deterministic fake for tests.
  The port means the choice is reversible.
- **Never auto-commits.** A geocode result is a suggestion the user confirms on a map. Silent
  auto-population is how wrong coordinates enter a system unnoticed.

### 4. Maps: tiles proxied through our own origin

The single-file frontend cannot survive contact with a map unchanged, so here is the honest
accounting.

**Tiles are proxied**, not fetched directly by the browser: `GET /map/tiles/{z}/{x}/{y}.png` on our
own API, which fetches upstream and caches. This costs Cloud Run bandwidth and adds a route, and
buys three things — the browser still talks only to our origin so the Content-Security-Policy stays
closed; the tile provider sees our server rather than the location of every field worker (constraint
4); and caching makes repeat views cheap on poor connections.

**The map library is vendored, not linked.** A pinned copy of Leaflet is checked in under
`packages/web/vendor/` and inlined at build time, taking the page from ~151 KB to ~200 KB. Hand-
rolling a slippy map was considered and rejected: pinch-zoom, inertia and touch target handling on
low-end Android phones have many edge cases, and our primary users are on exactly those devices.
A CDN link was rejected because it reintroduces an external dependency and a supply chain into a
page that deliberately has neither.

### 5. Device GPS

The browser Geolocation API, which requires HTTPS (satisfied) and explicit user permission.
`accuracyMetres` is recorded from the reading, and a fix worse than ~100 m is offered for
confirmation on the map rather than accepted outright — an indoor fix in a relief camp can be
kilometres out. Permission denial is a normal path, not an error: fall back to the map picker.

### 6. Offline behaviour, stated plainly

| Method | Works offline |
|---|---|
| Device GPS | **Yes** — the GNSS receiver needs no network |
| Manual entry | Yes |
| Map pin | No — needs tiles (cached tiles only, for previously viewed areas) |
| Geocoding | No |

Device GPS being the only fully offline method reinforces the trust ordering above: the most
reliable method is also the one that works where the work happens. Full offline capture and
sync remains out of scope (PRD §7).

## Alternatives considered

**Auto-populate silently from the village name.** What was literally asked for, and rejected as
stated because of constraint 1 — a geocoder that is often wrong, wired to fill a field without
confirmation, produces a map that is confidently incorrect. The same intent is served by
suggesting candidates and asking for one click of confirmation.

**Store only lat/lng, no provenance.** Smaller change, no migration. Rejected because it discards
the distinction between a surveyed position and a guess, which is the difference that matters
operationally.

**A `pending_survey` boolean instead of a source enum.** Nearly as useful and much cheaper.
Rejected because it cannot distinguish a map pin dropped by someone who knows the area from a
geocoder's output, and because booleans that summarise a category tend to be joined by more
booleans later.

**Nullable coordinates.** Rejected — see decision 2.

**Google Maps JS API in the page.** Best-in-class interaction and the most accurate imagery for
India. Rejected on privacy (every field worker's map session reported to a third party) and on the
external-dependency constraint; the proxy approach keeps the network boundary at our own origin.

**Third-party tiles fetched directly by the browser.** Simplest and cheapest. Rejected for the same
privacy reason, and because it makes the page's availability depend on a host we do not control.

## Consequences

- `GeoCoordinates` gains required `source`, so `Village.create` callers, the Supabase village
  adapter, the API route, seeded data and the village tests all change. The migration adds
  `geo_source`, `geo_accuracy_metres` and `geo_captured_at`; existing rows become `manual_entry`.
- `Issue` already captures a `gps` field with the same shape and the same ambiguity. It should
  adopt the same value object — a citizen's phone GPS on a broken bridge is exactly the
  high-trust case worth distinguishing — but that is follow-on work, not part of this decision.
- The page roughly grows by a third. On a 2G connection that is real; the map should therefore load
  only when a capture flow is opened, not on first paint.
- The tile proxy makes us responsible for upstream attribution and usage-policy compliance
  (OpenStreetMap's in particular), and for a cache-eviction policy. Neither is optional.
- Geocoding introduces per-request cost. Bias-by-district and caching by `(name, district)` keep it
  small, and the port makes switching to Nominatim a one-line composition change if it is not.
- "Which villages still need a surveyed position?" becomes answerable, and should become a District
  dashboard tile — the feature's real payoff is not nicer data entry but a visible data-quality gap.
