import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody, record, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

describe("development planning routes", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer({ apiToken: TOKEN });
  });

  afterEach(async () => {
    await server.close();
  });

  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    return server.request(path, { ...jsonBody(body), token: TOKEN });
  }

  async function village(): Promise<string> {
    const created = await post("/villages", VILLAGE_BODY);
    return record(created.body)["villageId"] as string;
  }

  /** A village with a plan carrying one goal and one milestone. */
  async function plannedVillage(): Promise<{
    villageId: string;
    planId: string;
    goalId: string;
    milestoneId: string;
  }> {
    const villageId = await village();
    const planId = record((await post(`/villages/${villageId}/plan`, {})).body)["planId"] as string;
    const goalId = record(
      (
        await post(`/plans/${planId}/goals`, {
          area: "education",
          description: "Reopen the primary school",
        })
      ).body,
    )["goalId"] as string;
    const milestoneId = record(
      (
        await post(`/plans/${planId}/goals/${goalId}/milestones`, {
          title: "Roof repaired",
          targetDate: "2026-09-01",
        })
      ).body,
    )["milestoneId"] as string;

    return { villageId, planId, goalId, milestoneId };
  }

  describe("POST /villages/:id/plan", () => {
    it("creates the village's plan and answers 201", async () => {
      const villageId = await village();
      const response = await post(`/villages/${villageId}/plan`, {});

      expect(response.status).toBe(201);
      expect(record(response.body)["planId"]).toBe("plan-1");
    });

    it("refuses a second plan for the same village", async () => {
      const villageId = await village();
      await post(`/villages/${villageId}/plan`, {});

      const response = await post(`/villages/${villageId}/plan`, {});

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("plan already exists for this village");
    });

    it("answers 401 without a token", async () => {
      const villageId = await village();
      const response = await server.request(`/villages/${villageId}/plan`, jsonBody({}));

      expect(response.status).toBe(401);
      expect(record(response.body)["error"]).toBe("missing bearer token");
    });
  });

  describe("POST /plans/:id/goals", () => {
    it("adds a goal and answers 201 with its id", async () => {
      const villageId = await village();
      const planId = record((await post(`/villages/${villageId}/plan`, {})).body)["planId"] as string;

      const response = await post(`/plans/${planId}/goals`, {
        area: "livelihood",
        description: "Restart weaving co-operative",
      });

      expect(response.status).toBe(201);
      expect(record(response.body)["goalId"]).toBe("goal-1");
    });

    it("rejects an area outside the plan-area enum", async () => {
      const villageId = await village();
      const planId = record((await post(`/villages/${villageId}/plan`, {})).body)["planId"] as string;

      const response = await post(`/plans/${planId}/goals`, {
        area: "cryptocurrency",
        description: "No",
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("invalid goal area: cryptocurrency");
    });

    it("rejects an empty description", async () => {
      const villageId = await village();
      const planId = record((await post(`/villages/${villageId}/plan`, {})).body)["planId"] as string;

      const response = await post(`/plans/${planId}/goals`, { area: "health", description: "   " });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("goal description must not be empty");
    });

    it("answers 404 for an unknown plan", async () => {
      const response = await post("/plans/plan-404/goals", {
        area: "health",
        description: "Mobile clinic",
      });

      expect(response.status).toBe(404);
      expect(record(response.body)["error"]).toBe("plan not found");
    });

    it("answers 401 without a token", async () => {
      const response = await server.request(
        "/plans/plan-1/goals",
        jsonBody({ area: "health", description: "Mobile clinic" }),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("POST /plans/:id/goals/:goalId/milestones", () => {
    it("adds a milestone to a goal", async () => {
      const { planId, goalId } = await plannedVillage();

      const response = await post(`/plans/${planId}/goals/${goalId}/milestones`, {
        title: "Desks delivered",
        targetDate: "2026-10-01",
      });

      expect(response.status).toBe(201);
      expect(record(response.body)["milestoneId"]).toBe("milestone-2");
    });

    it("answers 404 for a goal that is not on the plan", async () => {
      const { planId } = await plannedVillage();

      const response = await post(`/plans/${planId}/goals/goal-404/milestones`, {
        title: "Desks delivered",
        targetDate: "2026-10-01",
      });

      expect(response.status).toBe(404);
      expect(record(response.body)["error"]).toBe("goal not found: goal-404");
    });

    it("rejects an empty targetDate with the domain message", async () => {
      const { planId, goalId } = await plannedVillage();

      const response = await post(`/plans/${planId}/goals/${goalId}/milestones`, {
        title: "Desks delivered",
        targetDate: "  ",
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("milestone targetDate must not be empty");
    });

    it("answers 401 without a token", async () => {
      const { planId, goalId } = await plannedVillage();
      const response = await server.request(
        `/plans/${planId}/goals/${goalId}/milestones`,
        jsonBody({ title: "x", targetDate: "2026-10-01" }),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("POST /plans/:id/goals/:goalId/milestones/:milestoneId/complete", () => {
    it("completes a milestone and reports when", async () => {
      const { planId, goalId, milestoneId } = await plannedVillage();

      const response = await post(
        `/plans/${planId}/goals/${goalId}/milestones/${milestoneId}/complete`,
        {},
      );

      expect(response.status).toBe(200);
      expect(typeof record(response.body)["completedAt"]).toBe("string");
    });

    it("refuses to complete the same milestone twice", async () => {
      const { planId, goalId, milestoneId } = await plannedVillage();
      const path = `/plans/${planId}/goals/${goalId}/milestones/${milestoneId}/complete`;
      await post(path, {});

      const response = await post(path, {});

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("milestone is already completed");
    });

    it("answers 404 for an unknown milestone", async () => {
      const { planId, goalId } = await plannedVillage();

      const response = await post(
        `/plans/${planId}/goals/${goalId}/milestones/milestone-404/complete`,
        {},
      );

      expect(response.status).toBe(404);
      expect(record(response.body)["error"]).toBe("milestone not found: milestone-404");
    });

    it("answers 401 without a token", async () => {
      const { planId, goalId, milestoneId } = await plannedVillage();
      const response = await server.request(
        `/plans/${planId}/goals/${goalId}/milestones/${milestoneId}/complete`,
        jsonBody({}),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("GET /villages/:id/plan", () => {
    it("returns the plan with its goals and progress rollup", async () => {
      const { villageId, planId, goalId, milestoneId } = await plannedVillage();

      const before = await server.request(`/villages/${villageId}/plan`, { token: TOKEN });
      expect(before.status).toBe(200);
      expect(record(before.body)).toMatchObject({ planId, villageId });
      expect(record(record(before.body)["progress"])["overallPercent"]).toBe(0);

      await post(`/plans/${planId}/goals/${goalId}/milestones/${milestoneId}/complete`, {});

      const after = await server.request(`/villages/${villageId}/plan`, { token: TOKEN });
      const goals = record(after.body)["goals"] as Record<string, unknown>[];

      expect(record(record(after.body)["progress"])["overallPercent"]).toBe(100);
      expect(goals).toHaveLength(1);
      expect(goals[0]).toMatchObject({ id: goalId, area: "education" });
      expect((goals[0]!["milestones"] as Record<string, unknown>[])[0]).toMatchObject({
        id: milestoneId,
        title: "Roof repaired",
        targetDate: "2026-09-01",
      });
    });

    it("answers 404 for a village that has no plan", async () => {
      const villageId = await village();
      const response = await server.request(`/villages/${villageId}/plan`, { token: TOKEN });

      expect(response.status).toBe(404);
      expect(record(response.body)["error"]).toBe(`plan not found for village: ${villageId}`);
    });

    it("answers 401 without a token", async () => {
      const { villageId } = await plannedVillage();
      const response = await server.request(`/villages/${villageId}/plan`);

      expect(response.status).toBe(401);
    });
  });
});
