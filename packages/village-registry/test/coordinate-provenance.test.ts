import { describe, expect, it } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import {
  COORDINATE_SOURCES_BY_TRUST,
  SURVEYED_COORDINATE_SOURCES,
  Village,
  coordinateTrust,
  isAtLeastAsTrustedAs,
  isCoordinateSource,
  needsSurveyedPosition,
  type CoordinateSource,
  type GeoCoordinates,
  type VillageCreateProps,
} from "../src/index.js";

/** ADR 0012 §1 — coordinate provenance in the domain model. */

function propsWith(geo: GeoCoordinates): VillageCreateProps {
  return {
    id: unwrap(villageId("village-1")),
    name: "Rampur",
    district: "Barpeta",
    state: "Assam",
    geo,
    population: 1200,
    households: 250,
    affectedFamilies: 80,
    severity: "severe",
  };
}

const at = (lat: number, lng: number, source: CoordinateSource): GeoCoordinates => ({
  lat,
  lng,
  source,
});

describe("the trust ordering is data", () => {
  it("lists the four sources, most trusted first", () => {
    expect([...COORDINATE_SOURCES_BY_TRUST]).toEqual([
      "device_gps",
      "map_pin",
      "geocoded",
      "manual_entry",
    ]);
  });

  it("ranks by position in that list, device GPS best", () => {
    expect(coordinateTrust("device_gps")).toBe(0);
    expect(coordinateTrust("map_pin")).toBe(1);
    expect(coordinateTrust("geocoded")).toBe(2);
    expect(coordinateTrust("manual_entry")).toBe(3);
  });

  it("compares two sources without the caller writing the ordering out", () => {
    expect(isAtLeastAsTrustedAs("device_gps", "geocoded")).toBe(true);
    expect(isAtLeastAsTrustedAs("geocoded", "map_pin")).toBe(false);
    expect(isAtLeastAsTrustedAs("manual_entry", "manual_entry")).toBe(true);
  });

  it("recognises exactly the four sources", () => {
    for (const source of COORDINATE_SOURCES_BY_TRUST) expect(isCoordinateSource(source)).toBe(true);
    expect(isCoordinateSource("gps")).toBe(false);
    expect(isCoordinateSource("")).toBe(false);
    expect(isCoordinateSource(undefined)).toBe(false);
    expect(isCoordinateSource(3)).toBe(false);
  });
});

describe("which villages still need a surveyed position", () => {
  it("treats a position a human established as surveyed", () => {
    expect([...SURVEYED_COORDINATE_SOURCES]).toEqual(["device_gps", "map_pin"]);
    expect(needsSurveyedPosition(at(26.3, 91.0, "device_gps"))).toBe(false);
    expect(needsSurveyedPosition(at(26.3, 91.0, "map_pin"))).toBe(false);
  });

  it("treats an inferred position as pending survey", () => {
    expect(needsSurveyedPosition(at(26.3, 91.0, "geocoded"))).toBe(true);
    expect(needsSurveyedPosition(at(26.3, 91.0, "manual_entry"))).toBe(true);
  });

  it("answers the question straight off a registered village", () => {
    const guessed = unwrap(Village.create(propsWith(at(26.3, 91.0, "geocoded"))));
    expect(needsSurveyedPosition(guessed.geo)).toBe(true);

    const surveyed = guessed.updateDemographics({
      geo: { lat: 26.3012, lng: 91.0044, source: "device_gps", accuracyMetres: 8 },
    });
    expect(surveyed.ok).toBe(true);
    expect(needsSurveyedPosition(guessed.geo)).toBe(false);
  });
});

describe("Village.create validates provenance", () => {
  it("accepts each of the four sources", () => {
    for (const source of COORDINATE_SOURCES_BY_TRUST) {
      expect(Village.create(propsWith(at(26.3, 91.0, source))).ok).toBe(true);
    }
  });

  it("rejects a source outside the four, by Result rather than by throwing", () => {
    const result = Village.create(propsWith(at(26.3, 91.0, "satellite" as CoordinateSource)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "geo.source must be one of device_gps, map_pin, geocoded, manual_entry",
      );
    }
  });

  it("rejects a missing source", () => {
    const result = Village.create(
      propsWith({ lat: 26.3, lng: 91.0 } as unknown as GeoCoordinates),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a positive accuracy", () => {
    const result = Village.create(
      propsWith({ lat: 26.3, lng: 91.0, source: "device_gps", accuracyMetres: 12.5 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.geo.accuracyMetres).toBe(12.5);
  });

  it("rejects a zero, negative or non-finite accuracy", () => {
    for (const accuracyMetres of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const result = Village.create(
        propsWith({ lat: 26.3, lng: 91.0, source: "device_gps", accuracyMetres }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("geo.accuracyMetres must be a positive finite number when present");
      }
    }
  });

  it("accepts an ISO instant for capturedAt", () => {
    for (const capturedAt of ["2024-07-01T05:30:00Z", "2024-07-01T05:30:00.123+05:30"]) {
      expect(Village.create(propsWith({ lat: 26.3, lng: 91.0, source: "map_pin", capturedAt })).ok).toBe(
        true,
      );
    }
  });

  it("rejects a capturedAt that is not an ISO instant", () => {
    for (const capturedAt of ["2024", "yesterday", "2024-07-01", ""]) {
      const result = Village.create(propsWith({ lat: 26.3, lng: 91.0, source: "map_pin", capturedAt }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("geo.capturedAt must be an ISO instant when present");
    }
  });

  it("still enforces the lat/lng ranges alongside the new fields", () => {
    expect(Village.create(propsWith(at(-91, 0, "device_gps"))).ok).toBe(false);
    expect(Village.create(propsWith(at(0, 181, "device_gps"))).ok).toBe(false);
  });
});
