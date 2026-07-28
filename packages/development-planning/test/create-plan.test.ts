import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, SequentialIdGenerator } from "@afrip/shared-kernel";
import { CreatePlan, type CreatePlanInput } from "../src/application/create-plan.js";
import type { PlanRepository } from "../src/application/ports.js";

function buildRepository(overrides: Partial<PlanRepository> = {}): PlanRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    findByVillage: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function validInput(): CreatePlanInput {
  return { villageId: "village-1" as any };
}

describe("CreatePlan", () => {
  it("saves the new plan and returns its generated id", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("plan");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new CreatePlan({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.planId).toBe("plan-1");

    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = (repository.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(saved.id).toBe("plan-1");
    expect(saved.villageId).toBe("village-1");
    expect(saved.goals).toEqual([]);
  });

  it("publishes plan.created.v1 with the correct payload", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("plan");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new CreatePlan({ repository, clock, idGenerator, eventPublisher });

    await useCase.execute(validInput());

    expect(eventPublisher.eventNames()).toEqual(["plan.created.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "plan.created.v1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        planId: "plan-1",
        villageId: "village-1",
      },
    });
  });

  it("rejects if a plan already exists for the village", async () => {
    const existingPlan = { id: "plan-99", villageId: "village-1", goals: [] };
    const repository = buildRepository({
      findByVillage: vi.fn().mockResolvedValue(existingPlan),
    });
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("plan");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new CreatePlan({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("assigns fresh ids for each created plan", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("plan");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new CreatePlan({ repository, clock, idGenerator, eventPublisher });

    const first = await useCase.execute({ villageId: "village-1" as any });
    const second = await useCase.execute({ villageId: "village-2" as any });

    expect(first.ok && first.value.planId).toBe("plan-1");
    expect(second.ok && second.value.planId).toBe("plan-2");
  });
});
