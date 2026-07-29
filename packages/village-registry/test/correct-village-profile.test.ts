import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, unwrap, villageId } from "@afrip/shared-kernel";
import { CorrectVillageProfile } from "../src/application/correct-village-profile.js";
import type { VillageRepository } from "../src/application/ports.js";
import { Village } from "../src/domain/village.js";

function existingVillage(): Village {
  return unwrap(
    Village.create({
      id: unwrap(villageId("village-1")),
      name: "Rampur",
      district: "Patna",
      state: "Bihar",
      geo: { lat: 25.6, lng: 85.1, source: "manual_entry" },
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

interface Harness {
  useCase: CorrectVillageProfile;
  repository: VillageRepository;
  eventPublisher: CapturingEventPublisher;
  village: Village;
}

function harness(found: Village | null = existingVillage()): Harness {
  const repository = buildRepository({ findById: vi.fn().mockResolvedValue(found) });
  const clock = new FixedClock(new Date("2026-03-01T00:00:00.000Z"));
  const eventPublisher = new CapturingEventPublisher();
  return {
    useCase: new CorrectVillageProfile({ repository, clock, eventPublisher }),
    repository,
    eventPublisher,
    village: found as Village,
  };
}

describe("CorrectVillageProfile", () => {
  it("applies the correction, saves the aggregate and returns the amended profile", async () => {
    const { useCase, repository, village } = harness();

    const result = await useCase.execute({
      villageId: "village-1",
      population: 1240,
      reason: "census figure was mistyped at registration",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.villageId).toBe("village-1");
      expect(result.value.reason).toBe("census figure was mistyped at registration");
      expect(result.value.profile.population).toBe(1240);
      expect(result.value.profile.name).toBe("Rampur");
    }
    expect(village.population).toBe(1240);
    expect(repository.save).toHaveBeenCalledWith(village);
  });

  it("publishes village.profile-corrected.v1 with before and after for every changed field", async () => {
    const { useCase, eventPublisher } = harness();

    await useCase.execute({
      villageId: "village-1",
      population: 1240,
      households: 260,
      reason: "reconciled against the block office register",
    });

    expect(eventPublisher.eventNames()).toEqual(["village.profile-corrected.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "village.profile-corrected.v1",
      occurredAt: "2026-03-01T00:00:00.000Z",
      payload: {
        villageId: "village-1",
        changed: {
          population: { from: 1200, to: 1240 },
          households: { from: 250, to: 260 },
        },
        reason: "reconciled against the block office register",
      },
    });
  });

  it("reports only the fields that actually changed, ignoring values resupplied unchanged", async () => {
    const { useCase, eventPublisher } = harness();

    const result = await useCase.execute({
      villageId: "village-1",
      name: "Rampur", // unchanged
      district: "Patna", // unchanged
      geo: { lat: 25.6, lng: 85.1, source: "manual_entry" }, // unchanged
      population: 1240, // changed
      reason: "typo in the population only",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.changed).toEqual({ population: { from: 1200, to: 1240 } });
    expect(eventPublisher.published[0]?.payload).toMatchObject({
      changed: { population: { from: 1200, to: 1240 } },
    });
  });

  it("carries both sides of a geo correction", async () => {
    const { useCase } = harness();

    const result = await useCase.execute({
      villageId: "village-1",
      geo: { lat: 25.61, lng: 85.12, source: "manual_entry" },
      reason: "GPS reading taken at the wrong hamlet",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changed.geo).toEqual({
        from: { lat: 25.6, lng: 85.1, source: "manual_entry" },
        to: { lat: 25.61, lng: 85.12, source: "manual_entry" },
      });
    }
  });

  it("rejects an empty reason without touching the aggregate", async () => {
    const { useCase, repository, eventPublisher, village } = harness();

    const result = await useCase.execute({ villageId: "village-1", population: 1240, reason: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("reason must not be empty");
    expect(village.population).toBe(1200);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("rejects a whitespace-only reason", async () => {
    const { useCase, repository, eventPublisher } = harness();

    const result = await useCase.execute({ villageId: "village-1", population: 1240, reason: "   " });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("reason must not be empty");
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("trims the reason it records", async () => {
    const { useCase, eventPublisher } = harness();

    const result = await useCase.execute({
      villageId: "village-1",
      population: 1240,
      reason: "  re-surveyed  ",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBe("re-surveyed");
    expect(eventPublisher.published[0]?.payload).toMatchObject({ reason: "re-surveyed" });
  });

  it("rejects a correction that changes nothing rather than logging a no-op", async () => {
    const { useCase, repository, eventPublisher } = harness();

    const result = await useCase.execute({
      villageId: "village-1",
      name: "Rampur",
      population: 1200,
      reason: "double-checking",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("correction must change at least one field");
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("rejects a correction supplying no correctable field at all", async () => {
    const { useCase, repository, eventPublisher } = harness();

    const result = await useCase.execute({ villageId: "village-1", reason: "no fields supplied" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("correction must change at least one field");
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("surfaces the aggregate's own message when the correction breaks affectedFamilies <= households", async () => {
    const { useCase, repository, eventPublisher, village } = harness();

    const result = await useCase.execute({
      villageId: "village-1",
      affectedFamilies: 300,
      reason: "field team reported a higher figure",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("affectedFamilies must not exceed households");
    expect(village.affectedFamilies).toBe(80);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("surfaces the aggregate's own message for a non-integer population", async () => {
    const { useCase, repository, eventPublisher } = harness();

    const result = await useCase.execute({
      villageId: "village-1",
      population: 1240.5,
      reason: "averaged two counts",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("population must be a non-negative integer");
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns a not-found error and does not publish when the village does not exist", async () => {
    const { useCase, repository, eventPublisher } = harness(null);

    const result = await useCase.execute({
      villageId: "village-404",
      population: 1240,
      reason: "correcting the population",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Village not found: village-404");
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("rejects a blank village id before reaching the repository", async () => {
    const { useCase, repository } = harness();

    const result = await useCase.execute({ villageId: "  ", population: 1240, reason: "typo" });

    expect(result.ok).toBe(false);
    expect(repository.findById).not.toHaveBeenCalled();
  });
});
