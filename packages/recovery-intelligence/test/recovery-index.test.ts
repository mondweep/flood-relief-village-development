import { describe, expect, it } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import { DIMENSIONS, type Dimension } from "../src/domain/dimensions.js";
import { RecoveryIndex } from "../src/domain/recovery-index.js";
import { Weights } from "../src/domain/weights.js";

const AT_1 = "2026-03-01T00:00:00.000Z";
const AT_2 = "2026-03-02T00:00:00.000Z";

function newIndex(): RecoveryIndex {
  return RecoveryIndex.create(unwrap(villageId("village-1")));
}

function zeroWeightsWith(overrides: Partial<Record<Dimension, number>>): Weights {
  const values = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) values[d] = 0;
  return unwrap(Weights.of({ ...values, ...overrides }));
}

describe("RecoveryIndex", () => {
  it("starts with all 11 dimensions at 0, composite 0, empty history", () => {
    const index = newIndex();
    for (const d of DIMENSIONS) expect(index.scores[d]).toBe(0);
    expect(index.composite).toBe(0);
    expect(index.calculatedAt).toBeNull();
    expect(index.history).toHaveLength(0);
  });

  it("merges partial scores over existing ones, defaulting missing dimensions to 0", () => {
    const index = newIndex();
    unwrap(index.upsertScores({ infrastructure: 100 }, Weights.equal(), AT_1));
    unwrap(index.upsertScores({ education: 50 }, Weights.equal(), AT_2));

    expect(index.scores.infrastructure).toBe(100);
    expect(index.scores.education).toBe(50);
    expect(index.scores.health).toBe(0);
  });

  it("computes composite as the weighted mean rounded to the nearest integer", () => {
    const index = newIndex();
    const result = unwrap(index.upsertScores({ infrastructure: 100, education: 50 }, Weights.equal(), AT_1));
    // (100 + 50) / 11 = 13.63... -> 14
    expect(result.composite).toBe(14);
    expect(index.composite).toBe(14);
    expect(index.calculatedAt).toBe(AT_1);
  });

  it("computes composite with non-equal weights", () => {
    const index = newIndex();
    const weights = zeroWeightsWith({ water: 0.5, sanitation: 0.5 });
    const result = unwrap(index.upsertScores({ water: 80, sanitation: 71 }, weights, AT_1));
    // 0.5*80 + 0.5*71 = 75.5 -> 76
    expect(result.composite).toBe(76);
  });

  it("gives composite equal to the common score when all dimensions match under equal weights", () => {
    const index = newIndex();
    const all = {} as Record<Dimension, number>;
    for (const d of DIMENSIONS) all[d] = 55;
    const result = unwrap(index.upsertScores(all, Weights.equal(), AT_1));
    expect(result.composite).toBe(55);
  });

  it("appends to history on every recalculation, oldest first", () => {
    const index = newIndex();
    unwrap(index.upsertScores({ infrastructure: 100 }, Weights.equal(), AT_1));
    unwrap(index.upsertScores({ education: 50 }, Weights.equal(), AT_2));

    expect(index.history).toEqual([
      { composite: 9, calculatedAt: AT_1 },
      { composite: 14, calculatedAt: AT_2 },
    ]);
  });

  it("accepts boundary scores 0 and 100", () => {
    const index = newIndex();
    expect(index.upsertScores({ water: 0, road: 100 }, Weights.equal(), AT_1).ok).toBe(true);
  });

  it("rejects scores above 100 without mutating state", () => {
    const index = newIndex();
    const result = index.upsertScores({ health: 101 }, Weights.equal(), AT_1);
    expect(result.ok).toBe(false);
    expect(index.scores.health).toBe(0);
    expect(index.history).toHaveLength(0);
  });

  it("rejects negative scores", () => {
    const index = newIndex();
    expect(index.upsertScores({ health: -1 }, Weights.equal(), AT_1).ok).toBe(false);
  });

  it("rejects non-finite scores", () => {
    const index = newIndex();
    expect(index.upsertScores({ health: Number.NaN }, Weights.equal(), AT_1).ok).toBe(false);
  });

  it("rejects unknown dimension keys at runtime", () => {
    const index = newIndex();
    const scores = { bogus: 50 } as unknown as Partial<Record<Dimension, number>>;
    expect(index.upsertScores(scores, Weights.equal(), AT_1).ok).toBe(false);
  });

  it("exposes immutable snapshots of scores and history", () => {
    const index = newIndex();
    unwrap(index.upsertScores({ water: 40 }, Weights.equal(), AT_1));
    const scores = index.scores;
    scores.water = 99;
    expect(index.scores.water).toBe(40);
  });
});
