import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, unwrap, villageId } from "@afrip/shared-kernel";
import { MarkAsDemonstration } from "../src/application/mark-as-demonstration.js";
import type { VillageRepository } from "../src/application/ports.js";
import { Village } from "../src/domain/village.js";

function existingVillage(): Village {
  return unwrap(
    Village.create({
      id: unwrap(villageId("village-1")),
      name: "Rampur",
      district: "Barpeta",
      state: "Assam",
      geo: { lat: 26.3, lng: 91.0, source: "manual_entry" },
      population: 1200,
      households: 250,
      affectedFamilies: 80,
      severity: "critical",
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

function buildUseCase(repository: VillageRepository): {
  useCase: MarkAsDemonstration;
  eventPublisher: CapturingEventPublisher;
} {
  const eventPublisher = new CapturingEventPublisher();
  return {
    useCase: new MarkAsDemonstration({
      repository,
      clock: new FixedClock(new Date("2026-07-30T00:00:00.000Z")),
      eventPublisher,
    }),
    eventPublisher,
  };
}

describe("MarkAsDemonstration", () => {
  it("marks the village, saves it, and reports the flag back", async () => {
    const village = existingVillage();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const { useCase } = buildUseCase(repository);

    const result = await useCase.execute({ villageId: "village-1", reason: "seeded for the demo" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      villageId: "village-1",
      isDemonstration: true,
      alreadyMarked: false,
      reason: "seeded for the demo",
    });
    expect(village.isDemonstration).toBe(true);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("publishes village.marked-as-demonstration.v1 with the reason", async () => {
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(existingVillage()) });
    const { useCase, eventPublisher } = buildUseCase(repository);

    await useCase.execute({ villageId: "village-1", reason: "seeded during the 2026-07-28 incident" });

    expect(eventPublisher.eventNames()).toEqual(["village.marked-as-demonstration.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "village.marked-as-demonstration.v1",
      occurredAt: "2026-07-30T00:00:00.000Z",
      payload: {
        villageId: "village-1",
        name: "Rampur",
        reason: "seeded during the 2026-07-28 incident",
      },
    });
  });

  /**
   * Re-running a marking script must not fail, and must not fill the audit log
   * with the same declaration nine times — noise there is what makes the entries
   * that matter hard to find.
   */
  it("is idempotent: re-marking succeeds, writes nothing and publishes nothing", async () => {
    const village = existingVillage();
    village.markAsDemonstration();
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(village) });
    const { useCase, eventPublisher } = buildUseCase(repository);

    const result = await useCase.execute({ villageId: "village-1", reason: "again" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alreadyMarked).toBe(true);
    expect(result.value.isDemonstration).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toEqual([]);
  });

  it("requires a reason, like a correction does", async () => {
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(existingVillage()) });
    const { useCase } = buildUseCase(repository);

    const result = await useCase.execute({ villageId: "village-1", reason: "   " });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("reports a village that does not exist rather than creating one", async () => {
    const repository = buildRepository({ findById: vi.fn().mockResolvedValue(null) });
    const { useCase } = buildUseCase(repository);

    const result = await useCase.execute({ villageId: "village-9", reason: "demo" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/i);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("rejects a malformed villageId without touching the repository", async () => {
    const repository = buildRepository();
    const { useCase } = buildUseCase(repository);

    const result = await useCase.execute({ villageId: "", reason: "demo" });

    expect(result.ok).toBe(false);
    expect(repository.findById).not.toHaveBeenCalled();
  });

  /**
   * There is no `UnmarkAsDemonstration`, and this asserts the absence at the
   * package's surface rather than in prose. Clearing the flag would launder a
   * fabricated record into the real reporting; the repair path for a village
   * flagged in error is deliberately a superuser at the SQL console.
   */
  it("has no counterpart use case that clears the flag", async () => {
    const registry: Record<string, unknown> = await import("../src/index.js");
    const clearing = Object.keys(registry).filter((name) =>
      /^(Unmark|Clear|Unset|Reset).*Demonstration/i.test(name),
    );
    expect(clearing, `these exports can clear a demonstration flag: ${clearing.join(", ")}`).toEqual([]);
  });
});
