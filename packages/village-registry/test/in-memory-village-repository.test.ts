import { describe, expect, it } from "vitest";
import { unwrap, villageId } from "@afrip/shared-kernel";
import { InMemoryVillageRepository } from "../src/adapters/in-memory-village-repository.js";
import { Village } from "../src/domain/village.js";

function makeVillage(id: string): Village {
  return unwrap(
    Village.create({
      id: unwrap(villageId(id)),
      name: "Rampur",
      district: "Patna",
      state: "Bihar",
      geo: { lat: 25.6, lng: 85.1, source: "manual_entry" },
      population: 1200,
      households: 250,
      affectedFamilies: 80,
      severity: "severe",
    }),
  );
}

describe("InMemoryVillageRepository", () => {
  it("returns null when a village id is not found", async () => {
    const repository = new InMemoryVillageRepository();
    const result = await repository.findById(unwrap(villageId("missing")));
    expect(result).toBeNull();
  });

  it("saves and finds a village by id", async () => {
    const repository = new InMemoryVillageRepository();
    const village = makeVillage("village-1");

    await repository.save(village);
    const found = await repository.findById(village.id);

    expect(found).toBe(village);
  });

  it("lists all saved villages", async () => {
    const repository = new InMemoryVillageRepository();
    const first = makeVillage("village-1");
    const second = makeVillage("village-2");

    await repository.save(first);
    await repository.save(second);

    const all = await repository.listAll();
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([first, second]));
  });

  it("overwrites the existing entry when saving a village with the same id", async () => {
    const repository = new InMemoryVillageRepository();
    const village = makeVillage("village-1");
    await repository.save(village);

    unwrap(village.updateSeverity("critical"));
    await repository.save(village);

    const all = await repository.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.severity).toBe("critical");
  });
});
