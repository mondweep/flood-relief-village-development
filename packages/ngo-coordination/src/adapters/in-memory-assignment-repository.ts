import type { NgoId, VillageId } from "@afrip/shared-kernel";
import type { VillageAssignment } from "../domain/village-assignment.js";
import type { AssignmentRepository } from "../application/ports.js";

export class InMemoryAssignmentRepository implements AssignmentRepository {
  private readonly byId = new Map<string, VillageAssignment>();

  async findActiveByVillage(villageId: VillageId): Promise<VillageAssignment | undefined> {
    for (const assignment of this.byId.values()) {
      if (assignment.villageId === villageId && assignment.status === "active") return assignment;
    }
    return undefined;
  }

  async findActiveByNgo(ngoId: NgoId): Promise<VillageAssignment[]> {
    const result: VillageAssignment[] = [];
    for (const assignment of this.byId.values()) {
      if (assignment.ngoId === ngoId && assignment.status === "active") result.push(assignment);
    }
    return result;
  }

  async save(assignment: VillageAssignment): Promise<void> {
    this.byId.set(assignment.id, assignment);
  }
}
