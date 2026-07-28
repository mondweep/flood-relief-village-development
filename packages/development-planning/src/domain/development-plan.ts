import { err, ok, type PlanId, type Result, type VillageId } from "@afrip/shared-kernel";

export type PlanArea = "education" | "livelihood" | "health" | "infrastructure" | "women_empowerment" | "digital_literacy";

const PLAN_AREAS: readonly PlanArea[] = [
  "education",
  "livelihood",
  "health",
  "infrastructure",
  "women_empowerment",
  "digital_literacy",
];

export function isPlanArea(value: string): value is PlanArea {
  return (PLAN_AREAS as readonly string[]).includes(value);
}

// Local branded ID types for Goal and Milestone
export type GoalId = string & { readonly __brand: "GoalId" };
export type MilestoneId = string & { readonly __brand: "MilestoneId" };

export interface Milestone {
  readonly id: MilestoneId;
  readonly title: string;
  readonly targetDate: string; // ISO date
  readonly completedAt?: string; // ISO timestamp
}

export interface Goal {
  readonly id: GoalId;
  readonly area: PlanArea;
  readonly description: string;
  readonly milestones: Milestone[];
}

export interface DevelopmentPlanState {
  readonly id: PlanId;
  readonly villageId: VillageId;
  readonly goals: Goal[];
}

export class DevelopmentPlan {
  readonly id: PlanId;
  readonly villageId: VillageId;
  private _goals: Goal[];

  constructor(id: PlanId, villageId: VillageId) {
    this.id = id;
    this.villageId = villageId;
    this._goals = [];
  }

  get goals(): readonly Goal[] {
    return this._goals;
  }

  addGoal(area: string, description: string): Result<GoalId> {
    if (!isPlanArea(area)) {
      return err(`invalid goal area: ${area}`);
    }

    if (description.trim().length === 0) {
      return err("goal description must not be empty");
    }

    const goalId = `goal-${Date.now()}-${Math.random()}` as GoalId;
    const goal: Goal = {
      id: goalId,
      area,
      description,
      milestones: [],
    };

    this._goals.push(goal);
    return ok(goalId);
  }

  addMilestone(goalId: GoalId, title: string, targetDate: string): Result<MilestoneId> {
    const goal = this._goals.find((g) => g.id === goalId);
    if (!goal) {
      return err(`goal not found: ${goalId}`);
    }

    if (title.trim().length === 0) {
      return err("milestone title must not be empty");
    }

    if (targetDate.trim().length === 0) {
      return err("milestone targetDate must not be empty");
    }

    const milestoneId = `milestone-${Date.now()}-${Math.random()}` as MilestoneId;
    const milestone: Milestone = {
      id: milestoneId,
      title,
      targetDate,
    };

    (goal.milestones as Milestone[]).push(milestone);
    return ok(milestoneId);
  }

  completeMilestone(goalId: GoalId, milestoneId: MilestoneId, completedAt: string): Result<void> {
    const goal = this._goals.find((g) => g.id === goalId);
    if (!goal) {
      return err(`goal not found: ${goalId}`);
    }

    const milestone = goal.milestones.find((m) => m.id === milestoneId);
    if (!milestone) {
      return err(`milestone not found: ${milestoneId}`);
    }

    if (milestone.completedAt !== undefined) {
      return err("milestone is already completed");
    }

    // Mutate the milestone by creating a new one with completedAt
    const index = goal.milestones.indexOf(milestone);
    const updatedMilestone: Milestone = { ...milestone, completedAt };
    (goal.milestones as Milestone[])[index] = updatedMilestone;

    return ok(undefined);
  }

  getProgress(): { overallPercent: number; perGoal: Array<{ goalId: GoalId; area: PlanArea; percent: number }> } {
    if (this._goals.length === 0) {
      return { overallPercent: 0, perGoal: [] };
    }

    let totalMilestones = 0;
    let completedMilestones = 0;

    const perGoal = this._goals.map((goal) => {
      const goalTotal = goal.milestones.length;
      const goalCompleted = goal.milestones.filter((m) => m.completedAt !== undefined).length;

      totalMilestones += goalTotal;
      completedMilestones += goalCompleted;

      const percent = goalTotal === 0 ? 0 : Math.round((goalCompleted / goalTotal) * 100);

      return {
        goalId: goal.id,
        area: goal.area,
        percent,
      };
    });

    const overallPercent = totalMilestones === 0 ? 0 : Math.round((completedMilestones / totalMilestones) * 100);

    return { overallPercent, perGoal };
  }
}
