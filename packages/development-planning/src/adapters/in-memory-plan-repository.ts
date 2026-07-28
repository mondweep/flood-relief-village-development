import type { PlanId, VillageId } from "@afrip/shared-kernel";
import type { DevelopmentPlan } from "../domain/development-plan.js";
import type { PlanRepository } from "../application/ports.js";

/** In-memory fake adapter for PlanRepository — used in tests and local runs. */
export class InMemoryPlanRepository implements PlanRepository {
  private readonly plans = new Map<string, DevelopmentPlan>();

  async findById(id: PlanId): Promise<DevelopmentPlan | null> {
    return this.plans.get(id) ?? null;
  }

  async findByVillage(villageId: VillageId): Promise<DevelopmentPlan | null> {
    for (const plan of this.plans.values()) {
      if (plan.villageId === villageId) {
        return plan;
      }
    }
    return null;
  }

  async save(plan: DevelopmentPlan): Promise<void> {
    this.plans.set(plan.id, plan);
  }
}
