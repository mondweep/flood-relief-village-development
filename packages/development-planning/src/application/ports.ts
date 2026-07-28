import type { PlanId, VillageId } from "@afrip/shared-kernel";
import type { DevelopmentPlan } from "../domain/development-plan.js";

/** Outbound port: persistence for the DevelopmentPlan aggregate. */
export interface PlanRepository {
  findById(id: PlanId): Promise<DevelopmentPlan | null>;
  findByVillage(villageId: VillageId): Promise<DevelopmentPlan | null>;
  save(plan: DevelopmentPlan): Promise<void>;
}
