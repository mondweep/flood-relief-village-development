import {
  err,
  ok,
  type PlanId,
  type Result,
} from "@afrip/shared-kernel";
import type { GoalId, PlanArea } from "../domain/development-plan.js";
import type { PlanRepository } from "./ports.js";

export interface GetProgressInput {
  planId: PlanId;
}

export interface GetProgressOutput {
  overallPercent: number;
  perGoal: Array<{
    goalId: GoalId;
    area: PlanArea;
    percent: number;
  }>;
}

export interface GetProgressDeps {
  repository: PlanRepository;
}

export class GetProgress {
  constructor(private readonly deps: GetProgressDeps) {}

  async execute(input: GetProgressInput): Promise<Result<GetProgressOutput>> {
    // Fetch the plan
    const plan = await this.deps.repository.findById(input.planId);
    if (plan === null) {
      return err("plan not found");
    }

    // Get progress from the plan aggregate
    const progress = plan.getProgress();

    return ok({
      overallPercent: progress.overallPercent,
      perGoal: progress.perGoal,
    });
  }
}
