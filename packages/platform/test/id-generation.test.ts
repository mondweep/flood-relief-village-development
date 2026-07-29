import { describe, expect, it } from "vitest";
import { RandomIdGenerator } from "@afrip/shared-kernel";
import { createPlatform } from "../src/composition-root.js";

/**
 * Regression tests for a production data-loss incident.
 *
 * The composition root defaulted to `SequentialIdGenerator` — a test fake that
 * counts from zero in process memory. On Cloud Run with `min-instances=0` the
 * counter reset on every scale-to-zero while Postgres kept the rows, so the next
 * village registered after a restart was handed `village-1` again and the
 * Supabase adapter's upsert-by-primary-key silently overwrote the existing
 * village. A real record was destroyed before this was caught.
 *
 * The property that matters is not "ids look random" but "a fresh platform never
 * reissues an id an earlier platform already used" — which is exactly what a
 * restart is.
 */
describe("id generation survives a restart", () => {
  it("does not reissue ids to a freshly constructed platform", async () => {
    const village = {
      name: "Rampur",
      district: "Barpeta",
      state: "Assam",
      geo: { lat: 26.32, lng: 91.0 },
      population: 1200,
      households: 260,
      affectedFamilies: 190,
      severity: "severe" as const,
    };

    // Two platforms built the same way a restart builds them: no shared state.
    const before = createPlatform();
    const after = createPlatform();

    const first = await before.villageRegistry.registerVillage.execute(village);
    const second = await after.villageRegistry.registerVillage.execute(village);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.value.villageId).not.toBe(first.value.villageId);
  });

  it("issues distinct ids within one platform", async () => {
    const platform = createPlatform();
    const ids = new Set<string>();

    for (let i = 0; i < 25; i += 1) {
      const result = await platform.ngoCoordination.registerNgo.execute({
        name: `NGO ${i}`,
        focusAreas: ["relief"],
        capacity: 2,
      });
      expect(result.ok).toBe(true);
      if (result.ok) ids.add(result.value.ngoId);
    }

    expect(ids.size).toBe(25);
  });

  it("keeps the prefix so ids stay self-describing in logs and audit payloads", () => {
    const id = new RandomIdGenerator("village").next();
    expect(id.startsWith("village-")).toBe(true);
    expect(id.length).toBeGreaterThan("village-".length + 30);
  });

  it("still honours an injected generator, so tests keep deterministic ids", async () => {
    let n = 0;
    const platform = createPlatform({
      idGenerator: (prefix) => ({ next: () => `${prefix}-fixed-${(n += 1)}` }),
    });

    const result = await platform.ngoCoordination.registerNgo.execute({
      name: "Goonj",
      focusAreas: ["relief"],
      capacity: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ngoId).toBe("ngo-fixed-1");
  });
});
