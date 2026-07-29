import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, SequentialIdGenerator } from "@afrip/shared-kernel";
import { RegisterVillage, type RegisterVillageInput } from "../src/application/register-village.js";
import type { VillageRepository } from "../src/application/ports.js";

function buildRepository(overrides: Partial<VillageRepository> = {}): VillageRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function validInput(): RegisterVillageInput {
  return {
    name: "Rampur",
    district: "Patna",
    state: "Bihar",
    geo: { lat: 25.6, lng: 85.1, source: "manual_entry" },
    population: 1200,
    households: 250,
    affectedFamilies: 80,
    severity: "severe",
  };
}

describe("RegisterVillage", () => {
  it("saves the new village and returns its generated id", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("village");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RegisterVillage({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.villageId).toBe("village-1");

    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = (repository.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(saved.id).toBe("village-1");
    expect(saved.name).toBe("Rampur");
    expect(saved.severity).toBe("severe");
  });

  it("publishes village.registered.v1 with the correct payload", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("village");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RegisterVillage({ repository, clock, idGenerator, eventPublisher });

    await useCase.execute(validInput());

    expect(eventPublisher.eventNames()).toEqual(["village.registered.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "village.registered.v1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        villageId: "village-1",
        name: "Rampur",
        district: "Patna",
        severity: "severe",
      },
    });
  });

  it("does not save or publish when the input violates an invariant", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("village");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RegisterVillage({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute({ ...validInput(), households: 10, affectedFamilies: 999 });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("assigns a fresh id for each registered village", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("village");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RegisterVillage({ repository, clock, idGenerator, eventPublisher });

    const first = await useCase.execute(validInput());
    const second = await useCase.execute(validInput());

    expect(first.ok && first.value.villageId).toBe("village-1");
    expect(second.ok && second.value.villageId).toBe("village-2");
  });
});
