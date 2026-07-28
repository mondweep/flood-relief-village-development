import type { BeneficiaryId, VillageId } from "@afrip/shared-kernel";
import type { Beneficiary } from "../domain/beneficiary.js";
import type { BeneficiaryRepository } from "../application/ports.js";

/** In-memory fake adapter for BeneficiaryRepository — used in tests and local runs. */
export class InMemoryBeneficiaryRepository implements BeneficiaryRepository {
  private readonly beneficiaries = new Map<string, Beneficiary>();

  async findById(id: BeneficiaryId): Promise<Beneficiary | null> {
    return this.beneficiaries.get(id) ?? null;
  }

  async save(beneficiary: Beneficiary): Promise<void> {
    this.beneficiaries.set(beneficiary.id, beneficiary);
  }

  async listByVillage(villageId: VillageId): Promise<Beneficiary[]> {
    return Array.from(this.beneficiaries.values()).filter((b) => b.villageId === villageId);
  }

  async listAll(): Promise<Beneficiary[]> {
    return Array.from(this.beneficiaries.values());
  }
}
