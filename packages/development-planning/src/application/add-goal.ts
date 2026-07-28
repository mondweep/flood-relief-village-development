import {
  err,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type PlanId,
  type Result,
} from "@afrip/shared-kernel";
import type { GoalId, PlanArea } from "../domain/development-plan.js";
import type { PlanRepository } from "./ports.js";

export interface AddGoalInput {
  planId: PlanId;
  area: PlanArea;
  description: string;
}

export interface AddGoalOutput {
  goalId: GoalId;
}

export interface AddGoalDeps {
  repository: PlanRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class AddGoal {
  constructor(private readonly deps: AddGoalDeps) {}

  async execute(input: AddGoalInput): Promise<Result<AddGoalOutput>> {
    // Fetch the plan
    const plan = await this.deps.repository.findById(input.planId);
    if (plan === null) {
      return err("plan not found");
    }

    // Add goal to the plan
    const goalResult = plan.addGoal(input.area, input.description);
    if (!goalResult.ok) return err(goalResult.error);

    const goalId = goalResult.value;

    // Save the updated plan
    await this.deps.repository.save(plan);

    // Publish event
    const payload: Record<string, unknown> = {
      planId: plan.id,
      goalId,
      area: input.area,
      description: input.description,
    };
    const event: DomainEvent = {
      name: "plan.goal-added.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ goalId });
  }
}
