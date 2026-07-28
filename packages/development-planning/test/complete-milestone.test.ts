import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock } from "@afrip/shared-kernel";
import { DevelopmentPlan } from "../src/domain/development-plan.js";
import { CompleteMilestone, type CompleteMilestoneInput } from "../src/application/complete-milestone.js";
import type { PlanRepository } from "../src/application/ports.js";

function buildRepository(plan: DevelopmentPlan | null = null): PlanRepository {
  return {
    findById: vi.fn().mockResolvedValue(plan),
    findByVillage: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CompleteMilestone", () => {
  it("completes a milestone and saves the plan", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const goalIdResult = plan.addGoal("education", "Improve school", "goal-1" as any);
    if (!goalIdResult.ok) return;
    const goalId = goalIdResult.value;

    const milestoneResult = plan.addMilestone(goalId, "Complete repairs", "2026-12-31", "milestone-1" as any);
    if (!milestoneResult.ok) return;
    const milestoneId = milestoneResult.value;

    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-10-15T10:30:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new CompleteMilestone({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      planId: "plan-1" as any,
      goalId,
      milestoneId,
    });

    expect(result.ok).toBe(true);
    expect(plan.goals[0]?.milestones[0]?.completedAt).toBe("2026-10-15T10:30:00.000Z");
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(plan);
  });

  it("publishes plan.milestone-completed.v1 with correct payload", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const goalIdResult = plan.addGoal("education", "Improve school", "goal-1" as any);
    if (!goalIdResult.ok) return;
    const goalId = goalIdResult.value;

    const milestoneResult = plan.addMilestone(goalId, "Complete repairs", "2026-12-31", "milestone-1" as any);
    if (!milestoneResult.ok) return;
    const milestoneId = milestoneResult.value;

    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-10-15T10:30:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new CompleteMilestone({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      planId: "plan-1" as any,
      goalId,
      milestoneId,
    });

    expect(result.ok).toBe(true);
    expect(eventPublisher.eventNames()).toEqual(["plan.milestone-completed.v1"]);
    const event = eventPublisher.published[0];
    expect(event?.name).toBe("plan.milestone-completed.v1");
    expect(event?.occurredAt).toBe("2026-10-15T10:30:00.000Z");
    expect(event?.payload).toMatchObject({
      planId: "plan-1",
      goalId,
      milestoneId,
    });
  });

  it("rejects if plan does not exist", async () => {
    const repository = buildRepository(null);
    const clock = new FixedClock(new Date("2026-10-15T10:30:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new CompleteMilestone({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      planId: "plan-1" as any,
      goalId: "goal-1" as any,
      milestoneId: "milestone-1" as any,
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("rejects if milestone is already completed", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const goalIdResult = plan.addGoal("education", "Improve school", "goal-1" as any);
    if (!goalIdResult.ok) return;
    const goalId = goalIdResult.value;

    const milestoneResult = plan.addMilestone(goalId, "Complete repairs", "2026-12-31", "milestone-1" as any);
    if (!milestoneResult.ok) return;
    const milestoneId = milestoneResult.value;

    // Complete it once
    plan.completeMilestone(goalId, milestoneId, "2026-10-15T10:30:00.000Z");

    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-10-16T10:30:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new CompleteMilestone({ repository, clock, eventPublisher });

    // Try to complete again
    const result = await useCase.execute({
      planId: "plan-1" as any,
      goalId,
      milestoneId,
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("uses clock to set completion time", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const goalIdResult = plan.addGoal("education", "Improve school", "goal-1" as any);
    if (!goalIdResult.ok) return;
    const goalId = goalIdResult.value;

    const milestoneResult = plan.addMilestone(goalId, "Complete repairs", "2026-12-31", "milestone-1" as any);
    if (!milestoneResult.ok) return;
    const milestoneId = milestoneResult.value;

    const repository = buildRepository(plan);
    const testDate = new Date("2026-05-20T14:23:45.000Z");
    const clock = new FixedClock(testDate);
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new CompleteMilestone({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      planId: "plan-1" as any,
      goalId,
      milestoneId,
    });

    expect(result.ok).toBe(true);
    expect(plan.goals[0]?.milestones[0]?.completedAt).toBe(testDate.toISOString());
  });
});
