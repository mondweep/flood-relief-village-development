import { describe, expect, it } from "vitest";
import { DIMENSIONS, type Dimension } from "../src/domain/dimensions.js";
import { Weights } from "../src/domain/weights.js";

function record(value: number): Record<Dimension, number> {
  const out = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) out[d] = value;
  return out;
}

describe("Dimensions", () => {
  it("defines exactly the 11 specified dimensions", () => {
    expect(DIMENSIONS).toEqual([
      "infrastructure",
      "education",
      "health",
      "livelihood",
      "agriculture",
      "housing",
      "employment",
      "water",
      "sanitation",
      "road",
      "electricity",
    ]);
  });
});

describe("Weights", () => {
  it("provides default equal weights of 1/11 per dimension", () => {
    const weights = Weights.equal();
    for (const d of DIMENSIONS) {
      expect(weights.get(d)).toBeCloseTo(1 / 11, 12);
    }
  });

  it("accepts custom weights summing to 1", () => {
    const values = { ...record(0), water: 0.5, sanitation: 0.5 };
    const result = Weights.of(values);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.get("water")).toBe(0.5);
      expect(result.value.get("infrastructure")).toBe(0);
    }
  });

  it("accepts a sum within the 1e-9 tolerance", () => {
    const values = record(1 / 11);
    values.electricity = values.electricity + 1e-12;
    expect(Weights.of(values).ok).toBe(true);
  });

  it("rejects weights that do not sum to 1", () => {
    const result = Weights.of({ ...record(0), water: 0.5, sanitation: 0.4 });
    expect(result.ok).toBe(false);
  });

  it("rejects a sum off by more than the tolerance", () => {
    const values = record(1 / 11);
    values.electricity = values.electricity + 1e-6;
    expect(Weights.of(values).ok).toBe(false);
  });

  it("rejects a missing dimension", () => {
    const values: Partial<Record<Dimension, number>> = record(1 / 11);
    delete values.health;
    const result = Weights.of(values as Record<Dimension, number>);
    expect(result.ok).toBe(false);
  });

  it("rejects negative weights", () => {
    const result = Weights.of({ ...record(0.1), water: -0.1, sanitation: 0.1 });
    expect(result.ok).toBe(false);
  });

  it("rejects non-finite weights", () => {
    const result = Weights.of({ ...record(0), water: Number.NaN, sanitation: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown dimension keys", () => {
    const values = { ...record(1 / 11), bogus: 0 } as unknown as Record<Dimension, number>;
    expect(Weights.of(values).ok).toBe(false);
  });

  it("exposes an immutable snapshot via toRecord", () => {
    const weights = Weights.equal();
    const snapshot = weights.toRecord();
    snapshot.water = 99;
    expect(weights.get("water")).toBeCloseTo(1 / 11, 12);
  });
});
