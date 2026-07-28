import type { BeneficiaryId, VillageId } from "@afrip/shared-kernel";
import type { Beneficiary } from "../domain/beneficiary.js";

/** Outbound port: persistence for the Beneficiary aggregate. */
export interface BeneficiaryRepository {
  findById(id: BeneficiaryId): Promise<Beneficiary | null>;
  save(beneficiary: Beneficiary): Promise<void>;
  listByVillage(villageId: VillageId): Promise<Beneficiary[]>;
  listAll(): Promise<Beneficiary[]>;
}
