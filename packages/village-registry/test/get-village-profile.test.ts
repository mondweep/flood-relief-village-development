import { describe, expect, it, vi } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import { GetVillageProfile } from "../src/application/get-village-profile.js";
import type { VillageRepository } from "../src/application/ports.js";
import { Village } from "../src/domain/village.js";

function existingVillage(): Village {
  const village = unwrap(
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
  unwrap(
    village.recordDamageAssessment({
      assessedAt: "2026-02-01T00:00:00.000Z",
      housesDamaged: 5,
      schoolsDamaged: 1,
      healthCentresDamaged: 0,
      waterSourcesDamaged: 1,
      agricultureHectaresLost: 2,
      livestockLost: 0,
    }),
  );
  return village;
}

function buildRepository(overrides: Partial<VillageRepository> = {}): VillageRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("GetVillageProfile", () => {
  it("returns the full profile including the latest damage assessment", async () => {
    const village = existingVillage();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const useCase = new GetVillageProfile({ repository });

    const result = await useCase.execute({ villageId: "village-1" });

    expect(repository.findById).toHaveBeenCalledWith("village-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      id: "village-1",
      name: "Rampur",
      district: "Patna",
      state: "Bihar",
      geo: { lat: 25.6, lng: 85.1 },
      population: 1200,
      households: 250,
      affectedFamilies: 80,
      severity: "severe",
      damageAssessments: village.damageAssessments,
      latestDamageAssessment: village.latestDamageAssessment,
    });
  });

  it("returns a profile with a null latestDamageAssessment when none recorded", async () => {
    const village = unwrap(
      Village.create({
        id: unwrap(villageId("village-2")),
        name: "Sonpur",
        district: "Patna",
        state: "Bihar",
        geo: { lat: 25.5, lng: 85.2 },
        population: 800,
        households: 150,
        affectedFamilies: 20,
        severity: "minor",
      }),
    );
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const useCase = new GetVillageProfile({ repository });

    const result = await useCase.execute({ villageId: "village-2" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.latestDamageAssessment).toBeNull();
      expect(result.value.damageAssessments).toEqual([]);
    }
  });

  it("returns an error when the village is not found", async () => {
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(null) });
    const useCase = new GetVillageProfile({ repository });

    const result = await useCase.execute({ villageId: "unknown-village" });

    expect(result.ok).toBe(false);
  });

  it("returns an error and never calls the repository for a malformed villageId", async () => {
    const repository = buildRepository();
    const useCase = new GetVillageProfile({ repository });

    const result = await useCase.execute({ villageId: "" });

    expect(result.ok).toBe(false);
    expect(repository.findById).not.toHaveBeenCalled();
  });
});
