import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, unwrap, villageId } from "@afrip/shared-kernel";
import type { RecoveryIndexRepository, WeightsProvider } from "../src/application/ports.js";
import {
  UpsertDimensionScores,
  type UpsertDimensionScoresInput,
} from "../src/application/upsert-dimension-scores.js";
import { DIMENSIONS, type Dimension } from "../src/domain/dimensions.js";
import { RecoveryIndex } from "../src/domain/recovery-index.js";
import { Weights } from "../src/domain/weights.js";

const NOW = new Date("2026-03-01T10:00:00.000Z");
const NOW_ISO = "2026-03-01T10:00:00.000Z";

function buildRepository(overrides: Partial<RecoveryIndexRepository> = {}): RecoveryIndexRepository {
  return {
    findByVillage: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function buildWeightsProvider(weights: Weights = Weights.equal()): WeightsProvider {
  return { get: vi.fn().mockResolvedValue(weights) };
}

function buildUseCase(overrides: {
  repository?: RecoveryIndexRepository;
  weightsProvider?: WeightsProvider;
  eventPublisher?: CapturingEventPublisher;
} = {}) {
  const repository = overrides.repository ?? buildRepository();
  const weightsProvider = overrides.weightsProvider ?? buildWeightsProvider();
  const eventPublisher = overrides.eventPublisher ?? new CapturingEventPublisher();
  const clock = new FixedClock(NOW);
  const useCase = new UpsertDimensionScores({ repository, weightsProvider, clock, eventPublisher });
  return { useCase, repository, weightsProvider, eventPublisher };
}

function customWeights(overrides: Partial<Record<Dimension, number>>): Record<Dimension, number> {
  const values = {} as Record<Dimension, number>;
  for (const d of DIMENSIONS) values[d] = 0;
  return { ...values, ...overrides };
}

describe("UpsertDimensionScores", () => {
  it("creates a new index when none exists, saves it and returns the composite", async () => {
    const { useCase, repository } = buildUseCase();

    const result = await useCase.execute({
      villageId: "village-1",
      scores: { infrastructure: 100, education: 50 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.villageId).toBe("village-1");
      expect(result.value.composite).toBe(14);
      expect(result.value.calculatedAt).toBe(NOW_ISO);
      expect(result.value.scores.infrastructure).toBe(100);
      expect(result.value.scores.health).toBe(0);
    }
    expect(repository.findByVillage).toHaveBeenCalledWith("village-1");
    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(repository.save).mock.calls[0]?.[0] as RecoveryIndex;
    expect(saved).toBeInstanceOf(RecoveryIndex);
    expect(saved.composite).toBe(14);
    expect(saved.history).toHaveLength(1);
  });

  it("merges partial scores over the stored index and appends history", async () => {
    const existing = RecoveryIndex.create(unwrap(villageId("village-1")));
    unwrap(existing.upsertScores({ infrastructure: 100 }, Weights.equal(), "2026-02-01T00:00:00.000Z"));
    const repository = buildRepository({ findByVillage: vi.fn().mockResolvedValue(existing) });
    const { useCase } = buildUseCase({ repository });

    const result = await useCase.execute({ villageId: "village-1", scores: { education: 50 } });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(14);
    expect(repository.save).toHaveBeenCalledWith(existing);
    expect(existing.scores.infrastructure).toBe(100);
    expect(existing.scores.education).toBe(50);
    expect(existing.history).toHaveLength(2);
  });

  it("uses the stored weights from the WeightsProvider", async () => {
    const weights = unwrap(Weights.of(customWeights({ water: 0.5, sanitation: 0.5 })));
    const weightsProvider = buildWeightsProvider(weights);
    const { useCase } = buildUseCase({ weightsProvider });

    const result = await useCase.execute({
      villageId: "village-1",
      scores: { water: 80, sanitation: 71 },
    });

    expect(weightsProvider.get).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(76);
  });

  it("prefers weights provided in the input and does not consult the WeightsProvider", async () => {
    const weightsProvider = buildWeightsProvider();
    const { useCase } = buildUseCase({ weightsProvider });

    const result = await useCase.execute({
      villageId: "village-1",
      scores: { water: 80, sanitation: 71 },
      weights: customWeights({ water: 0.5, sanitation: 0.5 }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(76);
    expect(weightsProvider.get).not.toHaveBeenCalled();
  });

  it("emits recovery.score-calculated.v1 with villageId and composite", async () => {
    const { useCase, eventPublisher } = buildUseCase();

    await useCase.execute({ villageId: "village-1", scores: { infrastructure: 100 } });

    expect(eventPublisher.eventNames()).toEqual(["recovery.score-calculated.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "recovery.score-calculated.v1",
      occurredAt: NOW_ISO,
      payload: { villageId: "village-1", composite: 9 },
    });
  });

  it("returns an error and never touches the repository for a malformed villageId", async () => {
    const { useCase, repository, eventPublisher } = buildUseCase();

    const result = await useCase.execute({ villageId: "", scores: { water: 10 } });

    expect(result.ok).toBe(false);
    expect(repository.findByVillage).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns an error and does not save or publish for an out-of-range score", async () => {
    const { useCase, repository, eventPublisher } = buildUseCase();

    const result = await useCase.execute({ villageId: "village-1", scores: { health: 101 } });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns an error and does not save or publish for invalid provided weights", async () => {
    const { useCase, repository, eventPublisher } = buildUseCase();

    const result = await useCase.execute({
      villageId: "village-1",
      scores: { water: 10 },
      weights: customWeights({ water: 0.5 }), // sums to 0.5
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("does not mutate the stored index when validation fails", async () => {
    const existing = RecoveryIndex.create(unwrap(villageId("village-1")));
    unwrap(existing.upsertScores({ infrastructure: 100 }, Weights.equal(), "2026-02-01T00:00:00.000Z"));
    const repository = buildRepository({ findByVillage: vi.fn().mockResolvedValue(existing) });
    const { useCase } = buildUseCase({ repository });

    const result = await useCase.execute({ villageId: "village-1", scores: { health: -5 } });

    expect(result.ok).toBe(false);
    expect(existing.history).toHaveLength(1);
    expect(existing.scores.health).toBe(0);
  });

  it("supports a pure recalculation with an empty partial score map", async () => {
    const existing = RecoveryIndex.create(unwrap(villageId("village-1")));
    unwrap(existing.upsertScores({ infrastructure: 100 }, Weights.equal(), "2026-02-01T00:00:00.000Z"));
    const repository = buildRepository({ findByVillage: vi.fn().mockResolvedValue(existing) });
    const { useCase, eventPublisher } = buildUseCase({ repository });

    const result = await useCase.execute({ villageId: "village-1", scores: {} } satisfies UpsertDimensionScoresInput);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(9);
    expect(existing.history).toHaveLength(2);
    expect(eventPublisher.eventNames()).toEqual(["recovery.score-calculated.v1"]);
  });
});
