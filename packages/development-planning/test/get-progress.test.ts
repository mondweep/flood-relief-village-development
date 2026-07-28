import { describe, expect, it, vi } from "vitest";
import { DevelopmentPlan } from "../src/domain/development-plan.js";
import { GetProgress, type GetProgressInput } from "../src/application/get-progress.js";
import type { PlanRepository } from "../src/application/ports.js";

function buildRepository(plan: DevelopmentPlan | null = null): PlanRepository {
  return {
    findById: vi.fn().mockResolvedValue(plan),
    findByVillage: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe("GetProgress", () => {
  it("returns 0% progress for plan with no goals", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const repository = buildRepository(plan);
    const useCase = new GetProgress({ repository });

    const result = await useCase.execute({ planId: "plan-1" as any });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.overallPercent).toBe(0);
    expect(result.value.perGoal).toEqual([]);
  });

  it("returns 0% progress for goal with no milestones", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const goalIdResult = plan.addGoal("education", "Improve school");
    if (!goalIdResult.ok) return;

    const repository = buildRepository(plan);
    const useCase = new GetProgress({ repository });

    const result = await useCase.execute({ planId: "plan-1" as any });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.overallPercent).toBe(0);
    expect(result.value.perGoal).toHaveLength(1);
    expect(result.value.perGoal[0]?.percent).toBe(0);
  });

  it("calculates progress for a single goal with milestones", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const goalIdResult = plan.addGoal("education", "Improve school");
    if (!goalIdResult.ok) return;
    const goalId = goalIdResult.value;

    // Add 4 milestones, complete 1
    plan.addMilestone(goalId, "Milestone 1", "2026-12-31");
    plan.addMilestone(goalId, "Milestone 2", "2026-12-31");
    const m3Result = plan.addMilestone(goalId, "Milestone 3", "2026-12-31");
    plan.addMilestone(goalId, "Milestone 4", "2026-12-31");

    if (m3Result.ok) {
      plan.completeMilestone(goalId, m3Result.value, "2026-10-15T10:30:00.000Z");
    }

    const repository = buildRepository(plan);
    const useCase = new GetProgress({ repository });

    const result = await useCase.execute({ planId: "plan-1" as any });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.overallPercent).toBe(25);
    expect(result.value.perGoal).toHaveLength(1);
    expect(result.value.perGoal[0]).toMatchObject({
      goalId,
      area: "education",
      percent: 25,
    });
  });

  it("calculates progress across multiple goals", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);

    // Goal 1: education - 2 milestones, 1 completed (50%)
    const g1Result = plan.addGoal("education", "Education goal");
    if (!g1Result.ok) return;
    const g1Id = g1Result.value;

    const m1Result = plan.addMilestone(g1Id, "Milestone 1", "2026-12-31");
    const m2Result = plan.addMilestone(g1Id, "Milestone 2", "2026-12-31");
    if (m1Result.ok) {
      plan.completeMilestone(g1Id, m1Result.value, "2026-10-15T10:30:00.000Z");
    }

    // Goal 2: health - 2 milestones, 2 completed (100%)
    const g2Result = plan.addGoal("health", "Health goal");
    if (!g2Result.ok) return;
    const g2Id = g2Result.value;

    const m3Result = plan.addMilestone(g2Id, "Milestone 3", "2026-12-31");
    const m4Result = plan.addMilestone(g2Id, "Milestone 4", "2026-12-31");
    if (m3Result.ok) {
      plan.completeMilestone(g2Id, m3Result.value, "2026-10-15T10:30:00.000Z");
    }
    if (m4Result.ok) {
      plan.completeMilestone(g2Id, m4Result.value, "2026-10-15T10:30:00.000Z");
    }

    const repository = buildRepository(plan);
    const useCase = new GetProgress({ repository });

    const result = await useCase.execute({ planId: "plan-1" as any });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Overall: 3 out of 4 = 75%
    expect(result.value.overallPercent).toBe(75);
    expect(result.value.perGoal).toHaveLength(2);

    const educationGoal = result.value.perGoal.find((g) => g.area === "education");
    const healthGoal = result.value.perGoal.find((g) => g.area === "health");

    expect(educationGoal?.percent).toBe(50);
    expect(healthGoal?.percent).toBe(100);
  });

  it("rejects if plan does not exist", async () => {
    const repository = buildRepository(null);
    const useCase = new GetProgress({ repository });

    const result = await useCase.execute({ planId: "non-existent" as any });

    expect(result.ok).toBe(false);
  });

  it("returns per-goal info with goalId and area", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);

    const g1Result = plan.addGoal("education", "Education goal");
    if (!g1Result.ok) return;
    const g1Id = g1Result.value;

    plan.addMilestone(g1Id, "Milestone 1", "2026-12-31");

    const repository = buildRepository(plan);
    const useCase = new GetProgress({ repository });

    const result = await useCase.execute({ planId: "plan-1" as any });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.perGoal[0]).toMatchObject({
      goalId: g1Id,
      area: "education",
      percent: 0,
    });
  });
});
