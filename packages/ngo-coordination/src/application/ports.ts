import type { NgoId, VillageId } from "@afrip/shared-kernel";
import type { Ngo } from "../domain/ngo.js";
import type { VillageAssignment } from "../domain/village-assignment.js";

export interface NgoRepository {
  findById(id: NgoId): Promise<Ngo | undefined>;
  save(ngo: Ngo): Promise<void>;
}

export interface AssignmentRepository {
  findActiveByVillage(villageId: VillageId): Promise<VillageAssignment | undefined>;
  findActiveByNgo(ngoId: NgoId): Promise<VillageAssignment[]>;
  save(assignment: VillageAssignment): Promise<void>;
}
