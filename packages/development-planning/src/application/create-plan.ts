import {
  err,
  ok,
  planId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
  type VillageId,
} from "@afrip/shared-kernel";
import { DevelopmentPlan } from "../domain/development-plan.js";
import type { PlanRepository } from "./ports.js";

export interface CreatePlanInput {
  villageId: VillageId;
}

export interface CreatePlanOutput {
  planId: string;
}

export interface CreatePlanDeps {
  repository: PlanRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class CreatePlan {
  constructor(private readonly deps: CreatePlanDeps) {}

  async execute(input: CreatePlanInput): Promise<Result<CreatePlanOutput>> {
    // Check if plan already exists for this village
    const existing = await this.deps.repository.findByVillage(input.villageId);
    if (existing !== null) {
      return err("plan already exists for this village");
    }

    // Generate new plan ID
    const idResult = planId(this.deps.idGenerator.next());
    if (!idResult.ok) return err(idResult.error);

    const planIdValue = idResult.value;

    // Create the plan
    const plan = new DevelopmentPlan(planIdValue, input.villageId);

    // Save the plan
    await this.deps.repository.save(plan);

    // Publish event
    const payload: Record<string, unknown> = {
      planId: plan.id,
      villageId: plan.villageId,
    };
    const event: DomainEvent = {
      name: "plan.created.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ planId: plan.id });
  }
}
