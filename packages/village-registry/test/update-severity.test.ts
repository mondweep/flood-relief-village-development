import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, unwrap, villageId } from "@afrip/shared-kernel";
import { UpdateSeverity } from "../src/application/update-severity.js";
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
      severity: "moderate",
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

describe("UpdateSeverity", () => {
  it("updates the village severity, saves it and returns previous/new values", async () => {
    const village = existingVillage();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const clock = new FixedClock(new Date("2026-03-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new UpdateSeverity({ repository, clock, eventPublisher });

    const result = await useCase.execute({ villageId: "village-1", severity: "critical" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.previous).toBe("moderate");
      expect(result.value.severity).toBe("critical");
    }
    expect(village.severity).toBe("critical");
    expect(repository.save).toHaveBeenCalledWith(village);
  });

  it("publishes village.severity-updated.v1 with villageId, severity and previous", async () => {
    const village = existingVillage();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const clock = new FixedClock(new Date("2026-03-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new UpdateSeverity({ repository, clock, eventPublisher });

    await useCase.execute({ villageId: "village-1", severity: "critical" });

    expect(eventPublisher.eventNames()).toEqual(["village.severity-updated.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "village.severity-updated.v1",
      occurredAt: "2026-03-01T00:00:00.000Z",
      payload: { villageId: "village-1", severity: "critical", previous: "moderate" },
    });
  });

  it("returns an error and does not save or publish when the village is not found", async () => {
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(null) });
    const clock = new FixedClock(new Date("2026-03-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new UpdateSeverity({ repository, clock, eventPublisher });

    const result = await useCase.execute({ villageId: "village-1", severity: "critical" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns an error and does not save or publish for an invalid severity", async () => {
    const village = existingVillage();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const clock = new FixedClock(new Date("2026-03-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new UpdateSeverity({ repository, clock, eventPublisher });

    const result = await useCase.execute({ villageId: "village-1", severity: "apocalyptic" as never });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
    expect(village.severity).toBe("moderate");
  });
});
