import { describe, expect, it } from "vitest";
import { unwrap, projectId, villageId } from "@afrip/shared-kernel";
import { InMemoryProjectRepository } from "../src/adapters/in-memory-project-repository.js";
import { makeProject } from "./helpers.js";

describe("InMemoryProjectRepository", () => {
  it("returns null for an unknown id", async () => {
    const repository = new InMemoryProjectRepository();
    expect(await repository.findById(unwrap(projectId("nope")))).toBeNull();
  });

  it("saves and finds a project by id", async () => {
    const repository = new InMemoryProjectRepository();
    const project = makeProject({ id: "proj-7" });

    await repository.save(project);

    expect(await repository.findById(unwrap(projectId("proj-7")))).toBe(project);
  });

  it("overwrites on re-save of the same id", async () => {
    const repository = new InMemoryProjectRepository();
    await repository.save(makeProject({ id: "proj-7", name: "First" }));
    const updated = makeProject({ id: "proj-7", name: "Second" });

    await repository.save(updated);

    const found = await repository.findById(unwrap(projectId("proj-7")));
    expect(found?.name).toBe("Second");
    expect(await repository.listAll()).toHaveLength(1);
  });

  it("lists projects for a given village only", async () => {
    const repository = new InMemoryProjectRepository();
    await repository.save(makeProject({ id: "p1", villageId: "vil-1" }));
    await repository.save(makeProject({ id: "p2", villageId: "vil-2" }));
    await repository.save(makeProject({ id: "p3", villageId: "vil-1" }));

    const forVillage = await repository.listByVillage(unwrap(villageId("vil-1")));

    expect(forVillage.map((p) => p.id).sort()).toEqual(["p1", "p3"]);
  });

  it("lists all saved projects", async () => {
    const repository = new InMemoryProjectRepository();
    await repository.save(makeProject({ id: "p1" }));
    await repository.save(makeProject({ id: "p2" }));

    expect((await repository.listAll()).map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });
});
