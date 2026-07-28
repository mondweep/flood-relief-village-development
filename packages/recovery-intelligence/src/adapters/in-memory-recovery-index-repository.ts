import type { VillageId } from "@afrip/shared-kernel";
import type { RecoveryIndex } from "../domain/recovery-index.js";
import type { RecoveryIndexRepository } from "../application/ports.js";

/** In-memory fake of the RecoveryIndexRepository port (one index per village). */
export class InMemoryRecoveryIndexRepository implements RecoveryIndexRepository {
  private readonly byVillage = new Map<string, RecoveryIndex>();

  async findByVillage(villageId: VillageId): Promise<RecoveryIndex | null> {
    return this.byVillage.get(villageId) ?? null;
  }

  async save(index: RecoveryIndex): Promise<void> {
    this.byVillage.set(index.villageId, index);
  }
}
