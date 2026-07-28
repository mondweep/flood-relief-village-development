import type { VillageId } from "@afrip/shared-kernel";
import type { Village } from "../domain/village.js";
import type { VillageRepository } from "../application/ports.js";

/** In-memory fake adapter for VillageRepository — used in tests and local runs. */
export class InMemoryVillageRepository implements VillageRepository {
  private readonly villages = new Map<string, Village>();

  async findById(id: VillageId): Promise<Village | null> {
    return this.villages.get(id) ?? null;
  }

  async save(village: Village): Promise<void> {
    this.villages.set(village.id, village);
  }

  async listAll(): Promise<Village[]> {
    return Array.from(this.villages.values());
  }
}
