import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock } from "@afrip/shared-kernel";
import { DevelopmentPlan } from "../src/domain/development-plan.js";
import { AddGoal, type AddGoalInput } from "../src/application/add-goal.js";
import type { PlanRepository } from "../src/application/ports.js";

function buildRepository(plan: DevelopmentPlan | null = null): PlanRepository {
  return {
    findById: vi.fn().mockResolvedValue(plan),
    findByVillage: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function validInput(): AddGoalInput {
  return {
    planId: "plan-1" as any,
    area: "education",
    description: "Improve school infrastructure",
  };
}

describe("AddGoal", () => {
  it("adds a goal to an existing plan and saves it", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddGoal({ repository, clock, eventPublisher });

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.goalId).toBeDefined();
    expect(plan.goals).toHaveLength(1);
    expect(plan.goals[0]?.area).toBe("education");
    expect(plan.goals[0]?.description).toBe("Improve school infrastructure");

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(plan);
  });

  it("publishes plan.goal-added.v1 with correct payload", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddGoal({ repository, clock, eventPublisher });

    const result = await useCase.execute(validInput());
    if (!result.ok) return;

    expect(eventPublisher.eventNames()).toEqual(["plan.goal-added.v1"]);
    const event = eventPublisher.published[0];
    expect(event?.name).toBe("plan.goal-added.v1");
    expect(event?.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(event?.payload).toMatchObject({
      planId: "plan-1",
      goalId: result.value.goalId,
      area: "education",
      description: "Improve school infrastructure",
    });
  });

  it("rejects if plan does not exist", async () => {
    const repository = buildRepository(null);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddGoal({ repository, clock, eventPublisher });

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("rejects invalid goal area", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddGoal({ repository, clock, eventPublisher });

    // @ts-ignore - deliberately test invalid area
    const result = await useCase.execute({
      planId: "plan-1" as any,
      area: "invalid_area" as any,
      description: "Description",
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("adds multiple goals to the same plan", async () => {
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const repository = buildRepository(plan);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AddGoal({ repository, clock, eventPublisher });

    const first = await useCase.execute({
      planId: "plan-1" as any,
      area: "education",
      description: "Education goal",
    });
    const second = await useCase.execute({
      planId: "plan-1" as any,
      area: "health",
      description: "Health goal",
    });

    expect(first.ok && second.ok).toBe(true);
    expect(plan.goals).toHaveLength(2);
    expect(plan.goals[0]?.area).toBe("education");
    expect(plan.goals[1]?.area).toBe("health");
  });
});
