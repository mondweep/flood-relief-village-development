import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock } from "@afrip/shared-kernel";
import { DevelopmentPlan } from "../src/domain/development-plan.js";
import { AddMilestone, type AddMilestoneInput } from "../src/application/add-milestone.js";
import type { PlanRepository } from "../src/application/ports.js";

function buildRepository(plan: DevelopmentPlan | null = null): PlanRepository {
  return {
    findById: vi.fn().mockResolvedValue(plan),
    findByVillage: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe("AddMilestone", () => {
  it("adds a milestone to an existing goal and saves the plan", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const goalIdResult = plan.addGoal("education", "Improve school");
    if (!goalIdResult.ok) return;
    const goalId = goalIdResult.value;

    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddMilestone({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      planId: "plan-1" as any,
      goalId,
      title: "Complete roof repairs",
      targetDate: "2026-12-31",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.milestoneId).toBeDefined();
    expect(plan.goals[0]?.milestones).toHaveLength(1);
    expect(plan.goals[0]?.milestones[0]?.title).toBe("Complete roof repairs");
    expect(plan.goals[0]?.milestones[0]?.targetDate).toBe("2026-12-31");

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(plan);
  });

  it("publishes plan.milestone-added.v1 with correct payload", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const goalIdResult = plan.addGoal("education", "Improve school");
    if (!goalIdResult.ok) return;
    const goalId = goalIdResult.value;

    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddMilestone({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      planId: "plan-1" as any,
      goalId,
      title: "Complete roof repairs",
      targetDate: "2026-12-31",
    });

    if (!result.ok) return;

    expect(eventPublisher.eventNames()).toEqual(["plan.milestone-added.v1"]);
    const event = eventPublisher.published[0];
    expect(event?.name).toBe("plan.milestone-added.v1");
    expect(event?.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(event?.payload).toMatchObject({
      planId: "plan-1",
      goalId,
      milestoneId: result.value.milestoneId,
      title: "Complete roof repairs",
      targetDate: "2026-12-31",
    });
  });

  it("rejects if plan does not exist", async () => {
    const repository = buildRepository(null);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddMilestone({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      planId: "plan-1" as any,
      goalId: "goal-1" as any,
      title: "Milestone",
      targetDate: "2026-12-31",
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("rejects if goal does not exist in plan", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddMilestone({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      planId: "plan-1" as any,
      goalId: "non-existent-goal" as any,
      title: "Milestone",
      targetDate: "2026-12-31",
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("adds multiple milestones to the same goal", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const goalIdResult = plan.addGoal("education", "Improve school");
    if (!goalIdResult.ok) return;
    const goalId = goalIdResult.value;

    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddMilestone({ repository, clock, eventPublisher });

    const first = await useCase.execute({
      planId: "plan-1" as any,
      goalId,
      title: "First milestone",
      targetDate: "2026-06-30",
    });

    const second = await useCase.execute({
      planId: "plan-1" as any,
      goalId,
      title: "Second milestone",
      targetDate: "2026-12-31",
    });

    expect(first.ok && second.ok).toBe(true);
    expect(plan.goals[0]?.milestones).toHaveLength(2);
  });
});
