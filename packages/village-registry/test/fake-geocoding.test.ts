import { describe, expect, it } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import {
  DEFAULT_FAKE_PLACES,
  FakeGeocoding,
  Village,
  confirmCandidate,
  needsSurveyedPosition,
  type GeocodeCandidate,
} from "../src/index.js";

/** ADR 0012 §3 — the deterministic adapter, and what a candidate is allowed to become. */

const geocoder = new FakeGeocoding();

describe("FakeGeocoding.forward", () => {
  it("returns a ranked list, not a single answer", async () => {
    // "a" matches both Barpeta places, so the shape under test is a list even
    // when a caller would rather have been handed one row.
    const candidates = unwrap(await geocoder.forward({ name: "a", district: "Barpeta" }));

    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.map((c) => c.displayName)).toContain("Rampur, Barpeta, Assam, India");
    for (const candidate of candidates) {
      // Enough description for a human to choose between them.
      expect(candidate.displayName).toContain("Barpeta");
      expect(candidate.confidence).toBeGreaterThan(0);
    }
  });

  /**
   * The case ADR 0012 §Context 1 names: the same village name in two districts.
   * The district already on the form is what separates them.
   */
  it("resolves a repeated village name by the district on the form", async () => {
    const barpeta = unwrap(await geocoder.forward({ name: "Rampur", district: "Barpeta" }));
    const sivasagar = unwrap(await geocoder.forward({ name: "Rampur", district: "Sivasagar" }));

    expect(barpeta.map((c) => c.lat)).toEqual([26.3223]);
    expect(sivasagar.map((c) => c.lat)).toEqual([26.9826]);
    expect(DEFAULT_FAKE_PLACES.filter((p) => p.name === "Rampur")).toHaveLength(2);
  });

  it("is deterministic — the same query gives the same answer every time", async () => {
    const first = unwrap(await geocoder.forward({ name: "a", district: "Barpeta" }));
    const second = unwrap(await geocoder.forward({ name: "a", district: "Barpeta" }));
    const third = unwrap(await new FakeGeocoding().forward({ name: "a", district: "Barpeta" }));

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
  });

  it("ranks an exact name above a partial one and never claims certainty", async () => {
    const candidates = unwrap(await geocoder.forward({ name: "Kalgachia", district: "Barpeta" }));
    const partial = unwrap(await geocoder.forward({ name: "algach", district: "Barpeta" }));

    expect(candidates[0]?.confidence).toBe(0.9);
    expect(partial[0]?.confidence).toBe(0.6);
    for (const candidate of [...candidates, ...partial]) {
      expect(candidate.confidence).toBeLessThan(1);
    }
  });

  it("normalises transliteration differences in the district", async () => {
    const candidates = unwrap(await geocoder.forward({ name: "Majuli", district: "majuli " }));
    expect(candidates).toHaveLength(1);
  });

  /**
   * An empty list is a legitimate answer here — most chapori settlements are in
   * no gazetteer at all — and it is `ok`, not `err`, precisely so that the
   * caller can tell it apart from a geocoder that is down.
   */
  it("reports a genuine no-match as an empty ok, not an error", async () => {
    const result = await geocoder.forward({ name: "Nowhere Chapori", district: "Barpeta" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("does not cross district boundaries even on an exact name", async () => {
    const candidates = unwrap(await geocoder.forward({ name: "Majuli", district: "Barpeta" }));
    expect(candidates).toEqual([]);
  });

  it("honours the limit", async () => {
    const candidates = unwrap(await geocoder.forward({ name: "a", district: "Barpeta", limit: 1 }));
    expect(candidates).toHaveLength(1);
  });

  it("rejects an empty name or district", async () => {
    expect(await geocoder.forward({ name: " ", district: "Barpeta" })).toEqual({
      ok: false,
      error: "name must not be empty",
    });
    expect(await geocoder.forward({ name: "Rampur", district: "" })).toEqual({
      ok: false,
      error: "district must not be empty",
    });
  });

  it("can be seeded with a different table", async () => {
    const custom = new FakeGeocoding([
      { name: "Test Village", district: "Test District", lat: 1, lng: 2 },
    ]);
    const candidates = unwrap(
      await custom.forward({ name: "Test Village", district: "Test District" }),
    );

    expect(candidates[0]).toMatchObject({ lat: 1, lng: 2, provider: "fake" });
    expect(await custom.forward({ name: "Rampur", district: "Barpeta" })).toEqual({
      ok: true,
      value: [],
    });
  });
});

describe("FakeGeocoding.reverse", () => {
  it("describes the nearest known place", async () => {
    const place = unwrap(await geocoder.reverse({ lat: 26.3225, lng: 90.987 }));
    expect(place).toEqual({
      displayName: "Rampur, Barpeta, Assam, India",
      district: "Barpeta",
      state: "Assam",
      provider: "fake",
    });
  });

  it("errs rather than inventing a place in the middle of nowhere", async () => {
    const result = await geocoder.reverse({ lat: 0, lng: 0 });
    expect(result).toEqual({ ok: false, error: "no known place near that point" });
  });

  it("rejects an out-of-range point", async () => {
    expect((await geocoder.reverse({ lat: 91, lng: 0 })).ok).toBe(false);
    expect((await geocoder.reverse({ lat: 0, lng: -181 })).ok).toBe(false);
  });
});

describe("confirmCandidate", () => {
  const candidate: GeocodeCandidate = {
    lat: 26.3223,
    lng: 90.9871,
    confidence: 0.9,
    displayName: "Rampur, Barpeta, Assam, India",
    district: "Barpeta",
    provider: "fake",
  };

  it("stamps the position `geocoded`, whatever the confidence said", () => {
    const geo = confirmCandidate(candidate, "2024-07-01T05:30:00Z");

    expect(geo).toEqual({
      lat: 26.3223,
      lng: 90.9871,
      source: "geocoded",
      capturedAt: "2024-07-01T05:30:00Z",
    });
  });

  it("produces coordinates the aggregate accepts", () => {
    const created = Village.create({
      id: unwrap(villageId("village-1")),
      name: "Rampur",
      district: "Barpeta",
      state: "Assam",
      geo: confirmCandidate(candidate, "2024-07-01T05:30:00Z"),
      population: 1200,
      households: 250,
      affectedFamilies: 80,
      severity: "severe",
    });

    expect(created.ok).toBe(true);
  });

  /**
   * The point of the whole arrangement: a confirmed geocode is a complete,
   * storable record that is still visibly pending survey (ADR 0012 §2).
   */
  it("leaves the village needing a surveyed position", () => {
    const geo = confirmCandidate(candidate, "2024-07-01T05:30:00Z");
    expect(needsSurveyedPosition(geo)).toBe(true);
  });

  it("carries no accuracy — a geocode has no notion of one", () => {
    const geo = confirmCandidate(candidate, "2024-07-01T05:30:00Z");
    expect(geo.accuracyMetres).toBeUndefined();
  });
});
