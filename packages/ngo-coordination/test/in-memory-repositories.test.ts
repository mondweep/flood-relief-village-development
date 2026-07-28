import { describe, expect, it } from "vitest";
import { unwrap, type AssignmentId, type NgoId, type VillageId } from "@afrip/shared-kernel";
import { Ngo } from "../src/domain/ngo.js";
import { VillageAssignment } from "../src/domain/village-assignment.js";
import { InMemoryNgoRepository } from "../src/adapters/in-memory-ngo-repository.js";
import { InMemoryAssignmentRepository } from "../src/adapters/in-memory-assignment-repository.js";

describe("InMemoryNgoRepository", () => {
  it("saves and retrieves an Ngo by id", async () => {
    const repository = new InMemoryNgoRepository();
    const ngo = unwrap(
      Ngo.create({ id: "ngo-1" as NgoId, name: "Helping Hands", focusAreas: ["water"], capacity: 2 }),
    );

    await repository.save(ngo);
    const found = await repository.findById("ngo-1" as NgoId);

    expect(found).toBe(ngo);
  });

  it("returns undefined for an unknown id", async () => {
    const repository = new InMemoryNgoRepository();

    const found = await repository.findById("missing" as NgoId);

    expect(found).toBeUndefined();
  });
});

describe("InMemoryAssignmentRepository", () => {
  it("finds the active assignment for a village", async () => {
    const repository = new InMemoryAssignmentRepository();
    const assignment = VillageAssignment.create({
      id: "asn-1" as AssignmentId,
      villageId: "village-1" as VillageId,
      ngoId: "ngo-1" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.save(assignment);

    const found = await repository.findActiveByVillage("village-1" as VillageId);

    expect(found).toBe(assignment);
  });

  it("does not return a retired assignment as active", async () => {
    const repository = new InMemoryAssignmentRepository();
    const assignment = VillageAssignment.create({
      id: "asn-1" as AssignmentId,
      villageId: "village-1" as VillageId,
      ngoId: "ngo-1" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    unwrap(assignment.retire());
    await repository.save(assignment);

    const found = await repository.findActiveByVillage("village-1" as VillageId);

    expect(found).toBeUndefined();
  });

  it("finds all active assignments for an NGO, across multiple villages", async () => {
    const repository = new InMemoryAssignmentRepository();
    const a1 = VillageAssignment.create({
      id: "asn-1" as AssignmentId,
      villageId: "village-1" as VillageId,
      ngoId: "ngo-1" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    const a2 = VillageAssignment.create({
      id: "asn-2" as AssignmentId,
      villageId: "village-2" as VillageId,
      ngoId: "ngo-1" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    const a3 = VillageAssignment.create({
      id: "asn-3" as AssignmentId,
      villageId: "village-3" as VillageId,
      ngoId: "ngo-2" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.save(a1);
    await repository.save(a2);
    await repository.save(a3);

    const found = await repository.findActiveByNgo("ngo-1" as NgoId);

    expect(found).toEqual(expect.arrayContaining([a1, a2]));
    expect(found).toHaveLength(2);
  });

  it("keeps a retired assignment in storage instead of deleting it", async () => {
    const repository = new InMemoryAssignmentRepository();
    const assignment = VillageAssignment.create({
      id: "asn-1" as AssignmentId,
      villageId: "village-1" as VillageId,
      ngoId: "ngo-1" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.save(assignment);
    unwrap(assignment.retire());
    await repository.save(assignment);

    // re-saving the same id must not create a second active record nor lose the retired one
    const activeForNgo = await repository.findActiveByNgo("ngo-1" as NgoId);
    expect(activeForNgo).toHaveLength(0);
  });
});
