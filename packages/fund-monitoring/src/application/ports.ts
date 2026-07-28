import type { ProjectId, VillageId } from "@afrip/shared-kernel";
import type { FundedProject } from "../domain/funded-project.js";

/** Outbound port: persistence for the FundedProject aggregate. */
export interface ProjectRepository {
  findById(id: ProjectId): Promise<FundedProject | null>;
  save(project: FundedProject): Promise<void>;
  listByVillage(villageId: VillageId): Promise<FundedProject[]>;
  listAll(): Promise<FundedProject[]>;
}
