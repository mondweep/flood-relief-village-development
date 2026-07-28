import { describe, expect, it } from "vitest";
import { DevelopmentPlan } from "../src/domain/development-plan.js";
import { InMemoryPlanRepository } from "../src/adapters/in-memory-plan-repository.js";

describe("InMemoryPlanRepository", () => {
  it("saves and retrieves a plan by id", async () => {
    const repository = new InMemoryPlanRepository();
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);

    await repository.save(plan);
    const retrieved = await repository.findById("plan-1" as any);

    expect(retrieved).toBe(plan);
  });

  it("retrieves null for non-existent plan id", async () => {
    const repository = new InMemoryPlanRepository();

    const retrieved = await repository.findById("non-existent" as any);

    expect(retrieved).toBeNull();
  });

  it("retrieves plan by village id", async () => {
    const repository = new InMemoryPlanRepository();
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);

    await repository.save(plan);
    const retrieved = await repository.findByVillage("village-1" as any);

    expect(retrieved).toBe(plan);
  });

  it("retrieves null when village has no plan", async () => {
    const repository = new InMemoryPlanRepository();

    const retrieved = await repository.findByVillage("village-1" as any);

    expect(retrieved).toBeNull();
  });

  it("updates an existing plan on save", async () => {
    const repository = new InMemoryPlanRepository();
    const plan = new DevelopmentPlan("plan-1" as any, "village-1" as any);

    await repository.save(plan);

    // Modify the plan
    const goalResult = plan.addGoal("education", "Test goal");
    expect(goalResult.ok).toBe(true);

    await repository.save(plan);

    const retrieved = await repository.findById("plan-1" as any);
    expect(retrieved?.goals).toHaveLength(1);
  });

  it("only returns plan if village matches", async () => {
    const repository = new InMemoryPlanRepository();
    const plan1 = new DevelopmentPlan("plan-1" as any, "village-1" as any);
    const plan2 = new DevelopmentPlan("plan-2" as any, "village-2" as any);

    await repository.save(plan1);
    await repository.save(plan2);

    const retrieved1 = await repository.findByVillage("village-1" as any);
    const retrieved2 = await repository.findByVillage("village-2" as any);

    expect(retrieved1).toBe(plan1);
    expect(retrieved2).toBe(plan2);
  });
});
