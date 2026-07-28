import { describe, expect, it } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import { InMemoryRecoveryIndexRepository } from "../src/adapters/in-memory-recovery-index-repository.js";
import { StaticWeightsProvider } from "../src/adapters/static-weights-provider.js";
import { DIMENSIONS } from "../src/domain/dimensions.js";
import { RecoveryIndex } from "../src/domain/recovery-index.js";
import { Weights } from "../src/domain/weights.js";

describe("InMemoryRecoveryIndexRepository", () => {
  it("returns null for an unknown village", async () => {
    const repository = new InMemoryRecoveryIndexRepository();
    expect(await repository.findByVillage(unwrap(villageId("village-9")))).toBeNull();
  });

  it("saves and retrieves an index by village", async () => {
    const repository = new InMemoryRecoveryIndexRepository();
    const id = unwrap(villageId("village-1"));
    const index = RecoveryIndex.create(id);
    unwrap(index.upsertScores({ water: 40 }, Weights.equal(), "2026-03-01T00:00:00.000Z"));

    await repository.save(index);

    const found = await repository.findByVillage(id);
    expect(found).toBe(index);
  });

  it("overwrites on save for the same village (upsert semantics)", async () => {
    const repository = new InMemoryRecoveryIndexRepository();
    const id = unwrap(villageId("village-1"));
    const first = RecoveryIndex.create(id);
    const second = RecoveryIndex.create(id);

    await repository.save(first);
    await repository.save(second);

    expect(await repository.findByVillage(id)).toBe(second);
  });
});

describe("StaticWeightsProvider", () => {
  it("defaults to equal weights", async () => {
    const provider = new StaticWeightsProvider();
    const weights = await provider.get();
    for (const d of DIMENSIONS) expect(weights.get(d)).toBeCloseTo(1 / 11, 12);
  });

  it("returns the configured weights", async () => {
    const values = Object.fromEntries(DIMENSIONS.map((d) => [d, 0]));
    const custom = unwrap(Weights.of({ ...values, water: 1 } as Record<(typeof DIMENSIONS)[number], number>));
    const provider = new StaticWeightsProvider(custom);
    expect(await provider.get()).toBe(custom);
  });
});
