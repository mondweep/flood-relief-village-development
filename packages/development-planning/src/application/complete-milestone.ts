import {
  err,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type PlanId,
  type Result,
} from "@afrip/shared-kernel";
import type { GoalId, MilestoneId } from "../domain/development-plan.js";
import type { PlanRepository } from "./ports.js";

export interface CompleteMilestoneInput {
  planId: PlanId;
  goalId: GoalId;
  milestoneId: MilestoneId;
}

export interface CompleteMilestoneOutput {
  completedAt: string;
}

export interface CompleteMilestoneDeps {
  repository: PlanRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class CompleteMilestone {
  constructor(private readonly deps: CompleteMilestoneDeps) {}

  async execute(input: CompleteMilestoneInput): Promise<Result<CompleteMilestoneOutput>> {
    // Fetch the plan
    const plan = await this.deps.repository.findById(input.planId);
    if (plan === null) {
      return err("plan not found");
    }

    // Complete the milestone (uses clock for timestamp)
    const completedAt = this.deps.clock.now().toISOString();
    const completeResult = plan.completeMilestone(input.goalId, input.milestoneId, completedAt);
    if (!completeResult.ok) return err(completeResult.error);

    // Save the updated plan
    await this.deps.repository.save(plan);

    // Publish event
    const payload: Record<string, unknown> = {
      planId: plan.id,
      goalId: input.goalId,
      milestoneId: input.milestoneId,
    };
    const event: DomainEvent = {
      name: "plan.milestone-completed.v1",
      occurredAt: completedAt,
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ completedAt });
  }
}
