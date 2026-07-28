export type {
  DevelopmentPlanState,
  Goal,
  GoalId,
  Milestone,
  MilestoneId,
  PlanArea,
} from "./domain/development-plan.js";
export { DevelopmentPlan, isPlanArea } from "./domain/development-plan.js";

export type { PlanRepository } from "./application/ports.js";

export {
  CreatePlan,
  type CreatePlanDeps,
  type CreatePlanInput,
  type CreatePlanOutput,
} from "./application/create-plan.js";

export {
  AddGoal,
  type AddGoalDeps,
  type AddGoalInput,
  type AddGoalOutput,
} from "./application/add-goal.js";

export {
  AddMilestone,
  type AddMilestoneDeps,
  type AddMilestoneInput,
  type AddMilestoneOutput,
} from "./application/add-milestone.js";

export {
  CompleteMilestone,
  type CompleteMilestoneDeps,
  type CompleteMilestoneInput,
  type CompleteMilestoneOutput,
} from "./application/complete-milestone.js";

export {
  GetProgress,
  type GetProgressDeps,
  type GetProgressInput,
  type GetProgressOutput,
} from "./application/get-progress.js";

export { InMemoryPlanRepository } from "./adapters/in-memory-plan-repository.js";
