import { describe, expect, it } from "vitest";
import { planId, villageId } from "@afrip/shared-kernel";
import { DevelopmentPlan } from "../src/domain/development-plan.js";

describe("DevelopmentPlan", () => {
  it("creates a new plan with the given villageId", () => {
    const villageIdResult = villageId("village-1");
    expect(villageIdResult.ok).toBe(true);
    if (!villageIdResult.ok) return;

    const planIdResult = planId("plan-1");
    expect(planIdResult.ok).toBe(true);
    if (!planIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);

    expect(plan.id).toBe("plan-1");
    expect(plan.villageId).toBe("village-1");
    expect(plan.goals).toEqual([]);
  });

  it("adds a goal with area and description", () => {
    const planIdResult = planId("plan-1");
    const villageIdResult = villageId("village-1");
    if (!planIdResult.ok || !villageIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);
    const goalIdResult = plan.addGoal("education", "Improve primary school infrastructure", "goal-1" as any);

    expect(goalIdResult.ok).toBe(true);
    if (!goalIdResult.ok) return;

    const goalId = goalIdResult.value;
    expect(plan.goals).toHaveLength(1);
    expect(plan.goals[0]?.id).toBe(goalId);
    expect(plan.goals[0]?.area).toBe("education");
    expect(plan.goals[0]?.description).toBe("Improve primary school infrastructure");
    expect(plan.goals[0]?.milestones).toEqual([]);
  });

  it("rejects invalid goal areas", () => {
    const planIdResult = planId("plan-1");
    const villageIdResult = villageId("village-1");
    if (!planIdResult.ok || !villageIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);
    // @ts-ignore - deliberately pass invalid area for testing
    const result = plan.addGoal("invalid_area", "Description", "goal-1" as any);

    expect(result.ok).toBe(false);
  });

  it("adds a milestone to a goal", () => {
    const planIdResult = planId("plan-1");
    const villageIdResult = villageId("village-1");
    if (!planIdResult.ok || !villageIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);
    const goalIdResult = plan.addGoal("education", "Improve school", "goal-1" as any);
    if (!goalIdResult.ok) return;

    const goalId = goalIdResult.value;
    const milestoneResult = plan.addMilestone(goalId, "Complete roof repairs", "2026-12-31", "milestone-1" as any);

    expect(milestoneResult.ok).toBe(true);
    if (!milestoneResult.ok) return;

    const milestoneId = milestoneResult.value;
    const goal = plan.goals[0];
    expect(goal?.milestones).toHaveLength(1);
    expect(goal?.milestones[0]?.id).toBe(milestoneId);
    expect(goal?.milestones[0]?.title).toBe("Complete roof repairs");
    expect(goal?.milestones[0]?.targetDate).toBe("2026-12-31");
    expect(goal?.milestones[0]?.completedAt).toBeUndefined();
  });

  it("rejects adding milestone to non-existent goal", () => {
    const planIdResult = planId("plan-1");
    const villageIdResult = villageId("village-1");
    if (!planIdResult.ok || !villageIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);
    const result = plan.addMilestone("non-existent" as any, "Title", "2026-12-31", "milestone-1" as any);

    expect(result.ok).toBe(false);
  });

  it("completes a milestone", () => {
    const planIdResult = planId("plan-1");
    const villageIdResult = villageId("village-1");
    if (!planIdResult.ok || !villageIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);
    const goalIdResult = plan.addGoal("education", "Improve school", "goal-1" as any);
    if (!goalIdResult.ok) return;

    const goalId = goalIdResult.value;
    const milestoneResult = plan.addMilestone(goalId, "Complete repairs", "2026-12-31", "milestone-1" as any);
    if (!milestoneResult.ok) return;

    const milestoneId = milestoneResult.value;
    const completedDate = "2026-10-15T10:30:00.000Z";
    const completeResult = plan.completeMilestone(goalId, milestoneId, completedDate);

    expect(completeResult.ok).toBe(true);
    const milestone = plan.goals[0]?.milestones[0];
    expect(milestone?.completedAt).toBe(completedDate);
  });

  it("rejects completing an already-completed milestone", () => {
    const planIdResult = planId("plan-1");
    const villageIdResult = villageId("village-1");
    if (!planIdResult.ok || !villageIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);
    const goalIdResult = plan.addGoal("education", "Improve school", "goal-1" as any);
    if (!goalIdResult.ok) return;

    const goalId = goalIdResult.value;
    const milestoneResult = plan.addMilestone(goalId, "Complete repairs", "2026-12-31", "milestone-1" as any);
    if (!milestoneResult.ok) return;

    const milestoneId = milestoneResult.value;
    plan.completeMilestone(goalId, milestoneId, "2026-10-15T10:30:00.000Z");

    const secondAttempt = plan.completeMilestone(goalId, milestoneId, "2026-11-15T10:30:00.000Z");
    expect(secondAttempt.ok).toBe(false);
  });

  it("calculates progress for a single goal", () => {
    const planIdResult = planId("plan-1");
    const villageIdResult = villageId("village-1");
    if (!planIdResult.ok || !villageIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);
    const goalIdResult = plan.addGoal("education", "Improve school", "goal-1" as any);
    if (!goalIdResult.ok) return;

    const goalId = goalIdResult.value;

    // Add 4 milestones, complete 1
    plan.addMilestone(goalId, "Milestone 1", "2026-12-31", "milestone-1" as any);
    plan.addMilestone(goalId, "Milestone 2", "2026-12-31", "milestone-2" as any);
    const m3Result = plan.addMilestone(goalId, "Milestone 3", "2026-12-31", "milestone-3" as any);
    plan.addMilestone(goalId, "Milestone 4", "2026-12-31", "milestone-4" as any);

    if (m3Result.ok) {
      plan.completeMilestone(goalId, m3Result.value, "2026-10-15T10:30:00.000Z");
    }

    const progress = plan.getProgress();
    expect(progress.overallPercent).toBe(25); // 1 out of 4 = 25%
    expect(progress.perGoal).toHaveLength(1);
    expect(progress.perGoal[0]?.goalId).toBe(goalId);
    expect(progress.perGoal[0]?.area).toBe("education");
    expect(progress.perGoal[0]?.percent).toBe(25);
  });

  it("calculates 0% progress when no milestones exist", () => {
    const planIdResult = planId("plan-1");
    const villageIdResult = villageId("village-1");
    if (!planIdResult.ok || !villageIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);
    const goalIdResult = plan.addGoal("education", "Improve school", "goal-1" as any);
    if (!goalIdResult.ok) return;

    const progress = plan.getProgress();
    expect(progress.overallPercent).toBe(0);
    expect(progress.perGoal[0]?.percent).toBe(0);
  });

  it("calculates overall progress across multiple goals", () => {
    const planIdResult = planId("plan-1");
    const villageIdResult = villageId("village-1");
    if (!planIdResult.ok || !villageIdResult.ok) return;

    const plan = new DevelopmentPlan(planIdResult.value, villageIdResult.value);

    // Goal 1: 2 milestones, 1 completed
    const g1Result = plan.addGoal("education", "Education improvements", "goal-1" as any);
    if (!g1Result.ok) return;
    const g1Id = g1Result.value;
    const m1Result = plan.addMilestone(g1Id, "Milestone 1", "2026-12-31", "milestone-1" as any);
    const m2Result = plan.addMilestone(g1Id, "Milestone 2", "2026-12-31", "milestone-2" as any);
    if (m1Result.ok) {
      plan.completeMilestone(g1Id, m1Result.value, "2026-10-15T10:30:00.000Z");
    }

    // Goal 2: 2 milestones, 2 completed
    const g2Result = plan.addGoal("health", "Health improvements", "goal-2" as any);
    if (!g2Result.ok) return;
    const g2Id = g2Result.value;
    const m3Result = plan.addMilestone(g2Id, "Milestone 3", "2026-12-31", "milestone-3" as any);
    const m4Result = plan.addMilestone(g2Id, "Milestone 4", "2026-12-31", "milestone-4" as any);
    if (m3Result.ok) {
      plan.completeMilestone(g2Id, m3Result.value, "2026-10-15T10:30:00.000Z");
    }
    if (m4Result.ok) {
      plan.completeMilestone(g2Id, m4Result.value, "2026-10-15T10:30:00.000Z");
    }

    const progress = plan.getProgress();
    // Overall: 3 out of 4 = 75%
    expect(progress.overallPercent).toBe(75);
    expect(progress.perGoal).toHaveLength(2);
    expect(progress.perGoal[0]?.percent).toBe(50); // 1 out of 2
    expect(progress.perGoal[1]?.percent).toBe(100); // 2 out of 2
  });
});

describe("DevelopmentPlan encapsulation (regression)", () => {
  it("goals getter returns deep copies — mutating them does not affect the plan", () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    plan.addGoal("education", "Improve school", "goal-1" as any);
    plan.addMilestone("goal-1" as any, "Milestone 1", "2026-12-31", "milestone-1" as any);

    const leaked = plan.goals;
    (leaked as unknown as unknown[]).push({ forged: true });
    (leaked[0]!.milestones as unknown as unknown[]).push({ id: "forged", title: "x", targetDate: "y" });
    (leaked[0]!.milestones[0] as { completedAt?: string }).completedAt = "2026-01-01T00:00:00.000Z";

    expect(plan.goals).toHaveLength(1);
    expect(plan.goals[0]?.milestones).toHaveLength(1);
    expect(plan.goals[0]?.milestones[0]?.completedAt).toBeUndefined();
    expect(plan.getProgress().overallPercent).toBe(0);
  });

  it("uses caller-supplied ids instead of generating them inside the domain", () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);

    const goalResult = plan.addGoal("education", "Improve school", "goal-42" as any);
    expect(goalResult.ok).toBe(true);
    if (!goalResult.ok) return;
    expect(goalResult.value).toBe("goal-42");

    const milestoneResult = plan.addMilestone(goalResult.value, "Milestone", "2026-12-31", "milestone-7" as any);
    expect(milestoneResult.ok).toBe(true);
    if (!milestoneResult.ok) return;
    expect(milestoneResult.value).toBe("milestone-7");
  });
});
