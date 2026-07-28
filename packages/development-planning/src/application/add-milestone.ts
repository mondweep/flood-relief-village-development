import {
  err,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type PlanId,
  type Result,
} from "@afrip/shared-kernel";
import type { GoalId, MilestoneId } from "../domain/development-plan.js";
import type { PlanRepository } from "./ports.js";

export interface AddMilestoneInput {
  planId: PlanId;
  goalId: GoalId;
  title: string;
  targetDate: string;
}

export interface AddMilestoneOutput {
  milestoneId: MilestoneId;
}

export interface AddMilestoneDeps {
  repository: PlanRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class AddMilestone {
  constructor(private readonly deps: AddMilestoneDeps) {}

  async execute(input: AddMilestoneInput): Promise<Result<AddMilestoneOutput>> {
    // Fetch the plan
    const plan = await this.deps.repository.findById(input.planId);
    if (plan === null) {
      return err("plan not found");
    }

    // Add milestone to the goal with an injected id (ids are generated at the edge, not in the domain)
    const milestoneResult = plan.addMilestone(
      input.goalId,
      input.title,
      input.targetDate,
      this.deps.idGenerator.next() as MilestoneId,
    );
    if (!milestoneResult.ok) return err(milestoneResult.error);

    const milestoneId = milestoneResult.value;

    // Save the updated plan
    await this.deps.repository.save(plan);

    // Publish event
    const payload: Record<string, unknown> = {
      planId: plan.id,
      goalId: input.goalId,
      milestoneId,
      title: input.title,
      targetDate: input.targetDate,
    };
    const event: DomainEvent = {
      name: "plan.milestone-added.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ milestoneId });
  }
}
