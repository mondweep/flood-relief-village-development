import { describe, expect, it, vi } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import type { RecoveryIndexRepository } from "../src/application/ports.js";
import { GetRecoveryIndex } from "../src/application/get-recovery-index.js";
import { GetScoreHistory } from "../src/application/get-score-history.js";
import { RecoveryIndex } from "../src/domain/recovery-index.js";
import { Weights } from "../src/domain/weights.js";

const AT_1 = "2026-03-01T00:00:00.000Z";
const AT_2 = "2026-03-02T00:00:00.000Z";

function storedIndex(): RecoveryIndex {
  const index = RecoveryIndex.create(unwrap(villageId("village-1")));
  unwrap(index.upsertScores({ infrastructure: 100 }, Weights.equal(), AT_1));
  unwrap(index.upsertScores({ education: 50 }, Weights.equal(), AT_2));
  return index;
}

function buildRepository(overrides: Partial<RecoveryIndexRepository> = {}): RecoveryIndexRepository {
  return {
    findByVillage: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("GetRecoveryIndex", () => {
  it("returns the current snapshot for a stored village", async () => {
    const repository = buildRepository({ findByVillage: vi.fn().mockResolvedValue(storedIndex()) });
    const useCase = new GetRecoveryIndex({ repository });

    const result = await useCase.execute({ villageId: "village-1" });

    expect(repository.findByVillage).toHaveBeenCalledWith("village-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.villageId).toBe("village-1");
      expect(result.value.composite).toBe(14);
      expect(result.value.calculatedAt).toBe(AT_2);
      expect(result.value.scores.infrastructure).toBe(100);
      expect(result.value.scores.education).toBe(50);
      expect(result.value.scores.water).toBe(0);
    }
  });

  it("returns an error when no index exists for the village", async () => {
    const useCase = new GetRecoveryIndex({ repository: buildRepository() });
    const result = await useCase.execute({ villageId: "village-9" });
    expect(result.ok).toBe(false);
  });

  it("returns an error for a malformed villageId without calling the repository", async () => {
    const repository = buildRepository();
    const useCase = new GetRecoveryIndex({ repository });
    const result = await useCase.execute({ villageId: " " });
    expect(result.ok).toBe(false);
    expect(repository.findByVillage).not.toHaveBeenCalled();
  });
});

describe("GetScoreHistory", () => {
  it("returns the append-only history oldest first", async () => {
    const repository = buildRepository({ findByVillage: vi.fn().mockResolvedValue(storedIndex()) });
    const useCase = new GetScoreHistory({ repository });

    const result = await useCase.execute({ villageId: "village-1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.villageId).toBe("village-1");
      expect(result.value.history).toEqual([
        { composite: 9, calculatedAt: AT_1 },
        { composite: 14, calculatedAt: AT_2 },
      ]);
    }
  });

  it("returns an error when no index exists for the village", async () => {
    const useCase = new GetScoreHistory({ repository: buildRepository() });
    const result = await useCase.execute({ villageId: "village-9" });
    expect(result.ok).toBe(false);
  });

  it("returns an error for a malformed villageId without calling the repository", async () => {
    const repository = buildRepository();
    const useCase = new GetScoreHistory({ repository });
    const result = await useCase.execute({ villageId: "" });
    expect(result.ok).toBe(false);
    expect(repository.findByVillage).not.toHaveBeenCalled();
  });
});
