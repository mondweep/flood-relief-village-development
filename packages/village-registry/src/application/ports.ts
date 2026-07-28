import type { VillageId } from "@afrip/shared-kernel";
import type { Village } from "../domain/village.js";

/** Outbound port: persistence for the Village aggregate. */
export interface VillageRepository {
  findById(id: VillageId): Promise<Village | null>;
  save(village: Village): Promise<void>;
  listAll(): Promise<Village[]>;
}
