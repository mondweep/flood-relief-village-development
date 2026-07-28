import type { ProjectId, VillageId } from "@afrip/shared-kernel";
import type { FundedProject } from "../domain/funded-project.js";
import type { ProjectRepository } from "../application/ports.js";

/** In-memory fake of the ProjectRepository port for tests and the MVP walking skeleton. */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, FundedProject>();

  async findById(id: ProjectId): Promise<FundedProject | null> {
    return this.projects.get(id) ?? null;
  }

  async save(project: FundedProject): Promise<void> {
    this.projects.set(project.id, project);
  }

  async listByVillage(villageId: VillageId): Promise<FundedProject[]> {
    return [...this.projects.values()].filter((p) => p.villageId === villageId);
  }

  async listAll(): Promise<FundedProject[]> {
    return [...this.projects.values()];
  }
}
