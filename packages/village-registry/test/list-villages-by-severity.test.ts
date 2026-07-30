import { describe, expect, it, vi } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import { ListVillagesBySeverity } from "../src/application/list-villages-by-severity.js";
import type { VillageRepository } from "../src/application/ports.js";
import { Village, type Severity } from "../src/domain/village.js";

function makeVillage(id: string, name: string, severity: Severity): Village {
  return unwrap(
    Village.create({
      id: unwrap(villageId(id)),
      name,
      district: "Patna",
      state: "Bihar",
      geo: { lat: 25.6, lng: 85.1, source: "manual_entry" },
      population: 1000,
      households: 200,
      affectedFamilies: 50,
      severity,
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

describe("ListVillagesBySeverity", () => {
  it("returns villages sorted critical > severe > moderate > minor", async () => {
    const minor = makeVillage("village-1", "Minorville", "minor");
    const critical = makeVillage("village-2", "Criticalville", "critical");
    const moderate = makeVillage("village-3", "Moderateville", "moderate");
    const severe = makeVillage("village-4", "Severeville", "severe");

    const repository = buildRepository({
      listAll: vi.fn().mockResolvedValue([minor, critical, moderate, severe]),
    });
    const useCase = new ListVillagesBySeverity({ repository });

    const result = await useCase.execute();

    expect(repository.listAll).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((v) => v.id)).toEqual(["village-2", "village-4", "village-3", "village-1"]);
  });

  it("returns an empty array when there are no villages", async () => {
    const repository = buildRepository({ listAll: vi.fn().mockResolvedValue([]) });
    const useCase = new ListVillagesBySeverity({ repository });

    const result = await useCase.execute();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  /**
   * The list is what every counting query and every dashboard reads. If the
   * summary cannot say which rows are demonstration data, the only ways left to
   * tell are a per-row second fetch (which no caller will make) or the village's
   * name (which is not a fact, just a habit).
   */
  it("says which villages are demonstration data, and still lists them", async () => {
    const real = makeVillage("village-1", "Rampur", "critical");
    const demo = makeVillage("village-2", "Demo Village", "severe");
    demo.markAsDemonstration();

    const repository = buildRepository({ listAll: vi.fn().mockResolvedValue([real, demo]) });

    const result = await new ListVillagesBySeverity({ repository }).execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Listed, not filtered: the flag exists so these rows can be shown WITH a
    // label. Dropping them would swap a labelled illustration for an
    // unexplained absence.
    expect(result.value.map((v) => [v.id, v.isDemonstration])).toEqual([
      ["village-1", false],
      ["village-2", true],
    ]);
  });

  it("preserves relative order for villages sharing the same severity", async () => {
    const first = makeVillage("village-1", "First", "severe");
    const second = makeVillage("village-2", "Second", "severe");

    const repository = buildRepository({ listAll: vi.fn().mockResolvedValue([first, second]) });
    const useCase = new ListVillagesBySeverity({ repository });

    const result = await useCase.execute();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((v) => v.id)).toEqual(["village-1", "village-2"]);
  });
});
