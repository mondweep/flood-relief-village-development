import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, unwrap, villageId } from "@afrip/shared-kernel";
import {
  RecordDamageAssessment,
  type RecordDamageAssessmentInput,
} from "../src/application/record-damage-assessment.js";
import type { VillageRepository } from "../src/application/ports.js";
import { Village } from "../src/domain/village.js";

function existingVillage(): Village {
  return unwrap(
    Village.create({
      id: unwrap(villageId("village-1")),
      name: "Rampur",
      district: "Patna",
      state: "Bihar",
      geo: { lat: 25.6, lng: 85.1 },
      population: 1200,
      households: 250,
      affectedFamilies: 80,
      severity: "severe",
    }),
  );
}

function buildRepository(overrides: Partial<VillageRepository> = {}): VillageRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function validInput(): RecordDamageAssessmentInput {
  return {
    villageId: "village-1",
    assessment: {
      housesDamaged: 5,
      schoolsDamaged: 1,
      healthCentresDamaged: 0,
      waterSourcesDamaged: 1,
      agricultureHectaresLost: 2.5,
      livestockLost: 0,
    },
  };
}

describe("RecordDamageAssessment", () => {
  it("appends the assessment to the found village and saves it", async () => {
    const village = existingVillage();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const clock = new FixedClock(new Date("2026-02-01T12:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RecordDamageAssessment({ repository, clock, eventPublisher });

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(true);
    expect(repository.findById).toHaveBeenCalledWith("village-1");
    expect(repository.save).toHaveBeenCalledWith(village);
    expect(village.damageAssessments).toHaveLength(1);
    expect(village.latestDamageAssessment?.assessedAt).toBe("2026-02-01T12:00:00.000Z");
    expect(village.latestDamageAssessment?.housesDamaged).toBe(5);
  });

  it("publishes village.damage-assessed.v1 with villageId and assessedAt", async () => {
    const village = existingVillage();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const clock = new FixedClock(new Date("2026-02-01T12:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RecordDamageAssessment({ repository, clock, eventPublisher });

    await useCase.execute(validInput());

    expect(eventPublisher.eventNames()).toEqual(["village.damage-assessed.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "village.damage-assessed.v1",
      occurredAt: "2026-02-01T12:00:00.000Z",
      payload: { villageId: "village-1", assessedAt: "2026-02-01T12:00:00.000Z" },
    });
  });

  it("returns an error and does not save or publish when the village is not found", async () => {
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(null) });
    const clock = new FixedClock(new Date("2026-02-01T12:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RecordDamageAssessment({ repository, clock, eventPublisher });

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns an error and does not save or publish when the assessment has a negative count", async () => {
    const village = existingVillage();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const clock = new FixedClock(new Date("2026-02-01T12:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RecordDamageAssessment({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      villageId: "village-1",
      assessment: { ...validInput().assessment, housesDamaged: -3 },
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
    expect(village.damageAssessments).toHaveLength(0);
  });

  it("returns an error and never calls the repository for a malformed villageId", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-02-01T12:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RecordDamageAssessment({ repository, clock, eventPublisher });

    const result = await useCase.execute({ ...validInput(), villageId: "" });

    expect(result.ok).toBe(false);
    expect(repository.findById).not.toHaveBeenCalled();
  });
});
