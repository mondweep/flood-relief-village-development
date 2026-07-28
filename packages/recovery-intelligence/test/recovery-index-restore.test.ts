import { describe, expect, it } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import { zeroScores, type DimensionScores } from "../src/domain/dimensions.js";
import {
  RecoveryIndex,
  type RecoveryIndexRestoreProps,
} from "../src/domain/recovery-index.js";
import { Weights } from "../src/domain/weights.js";

function scores(overrides: Partial<DimensionScores> = {}): DimensionScores {
  return { ...zeroScores(), ...overrides };
}

function restoreProps(
  overrides: Partial<RecoveryIndexRestoreProps> = {},
): RecoveryIndexRestoreProps {
  return {
    villageId: unwrap(villageId("village-1")),
    scores: scores({ water: 88, health: 22 }),
    composite: 10,
    calculatedAt: "2026-04-01T00:00:00.000Z",
    history: [
      { composite: 6, calculatedAt: "2026-03-01T00:00:00.000Z" },
      { composite: 10, calculatedAt: "2026-04-01T00:00:00.000Z" },
    ],
    ...overrides,
  };
}

describe("RecoveryIndex.restore", () => {
  it("rebuilds the aggregate with its scores, composite and history", () => {
    const index = unwrap(RecoveryIndex.restore(restoreProps()));

    expect(index.villageId).toBe("village-1");
    expect(index.scores).toEqual(scores({ water: 88, health: 22 }));
    expect(index.composite).toBe(10);
    expect(index.calculatedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(index.history).toEqual([
      { composite: 6, calculatedAt: "2026-03-01T00:00:00.000Z" },
      { composite: 10, calculatedAt: "2026-04-01T00:00:00.000Z" },
    ]);
  });

  it("preserves a history computed under different weights", () => {
    // 70 is only reachable with water-only weights; equal weights would give 6.
    const index = unwrap(
      RecoveryIndex.restore(
        restoreProps({
          scores: scores({ water: 70 }),
          composite: 70,
          history: [{ composite: 70, calculatedAt: "2026-03-01T00:00:00.000Z" }],
        }),
      ),
    );
    expect(index.composite).toBe(70);
    expect(index.history.map((h) => h.composite)).toEqual([70]);
  });

  it("accepts a never-calculated index only when it also has no history", () => {
    const blank = RecoveryIndex.restore(
      restoreProps({ scores: zeroScores(), composite: 0, calculatedAt: null, history: [] }),
    );
    expect(blank.ok).toBe(true);
    expect(unwrap(blank).calculatedAt).toBeNull();

    const inconsistent = RecoveryIndex.restore(restoreProps({ calculatedAt: null }));
    expect(inconsistent.ok).toBe(false);
    expect(inconsistent.ok ? "" : inconsistent.error).toMatch(/history must have a calculatedAt/);
  });

  it("rejects a missing or unknown dimension in the stored scores", () => {
    const { water: _water, ...partial } = scores();
    const missing = RecoveryIndex.restore(
      restoreProps({ scores: partial as DimensionScores }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.ok ? "" : missing.error).toMatch(/missing score for dimension: water/);

    const unknown = RecoveryIndex.restore(
      restoreProps({ scores: { ...scores(), vibes: 10 } as never }),
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? "" : unknown.error).toMatch(/unknown dimension: vibes/);
  });

  it("rejects scores outside 0-100", () => {
    expect(RecoveryIndex.restore(restoreProps({ scores: scores({ water: 101 }) })).ok).toBe(false);
    expect(RecoveryIndex.restore(restoreProps({ scores: scores({ water: -1 }) })).ok).toBe(false);
    expect(RecoveryIndex.restore(restoreProps({ scores: scores({ water: NaN }) })).ok).toBe(false);
  });

  it("rejects a composite that is not an integer in 0-100", () => {
    for (const composite of [-1, 101, 10.5, NaN]) {
      const result = RecoveryIndex.restore(restoreProps({ composite }));
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toMatch(/composite must be an integer between 0 and 100/);
    }
  });

  it("rejects a history entry with a bad composite or an empty timestamp", () => {
    const badComposite = RecoveryIndex.restore(
      restoreProps({ history: [{ composite: 500, calculatedAt: "2026-03-01T00:00:00.000Z" }] }),
    );
    expect(badComposite.ok).toBe(false);
    expect(badComposite.ok ? "" : badComposite.error).toMatch(/history composite/);

    const badTimestamp = RecoveryIndex.restore(
      restoreProps({ history: [{ composite: 6, calculatedAt: "  " }] }),
    );
    expect(badTimestamp.ok).toBe(false);
    expect(badTimestamp.ok ? "" : badTimestamp.error).toMatch(/history calculatedAt/);
  });

  it("rejects an empty calculatedAt", () => {
    expect(RecoveryIndex.restore(restoreProps({ calculatedAt: "   " })).ok).toBe(false);
  });

  it("copies the inputs so later mutation of the caller's data cannot leak in", () => {
    const props = restoreProps();
    const index = unwrap(RecoveryIndex.restore(props));

    props.scores.water = 1;
    (props.history as unknown[]).push({ composite: 0, calculatedAt: "2027-01-01T00:00:00.000Z" });

    expect(index.scores.water).toBe(88);
    expect(index.history).toHaveLength(2);
  });

  it("returns a live aggregate whose next upsert appends to the restored history", () => {
    const index = unwrap(RecoveryIndex.restore(restoreProps()));

    const result = unwrap(
      index.upsertScores({ road: 55 }, Weights.equal(), "2026-05-01T00:00:00.000Z"),
    );

    expect(index.history).toHaveLength(3);
    expect(index.history[2]).toEqual({
      composite: result.composite,
      calculatedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(index.scores.water).toBe(88);
    expect(index.scores.road).toBe(55);
  });
});
