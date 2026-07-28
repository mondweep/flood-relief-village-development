import type { VillageId } from "@afrip/shared-kernel";
import type { RecoveryIndex } from "../domain/recovery-index.js";
import type { Weights } from "../domain/weights.js";

/** Outbound port: persistence for the RecoveryIndex aggregate. */
export interface RecoveryIndexRepository {
  findByVillage(villageId: VillageId): Promise<RecoveryIndex | null>;
  save(index: RecoveryIndex): Promise<void>;
}

/** Outbound port: the stored dimension weights used for composite calculation. */
export interface WeightsProvider {
  get(): Promise<Weights>;
}
