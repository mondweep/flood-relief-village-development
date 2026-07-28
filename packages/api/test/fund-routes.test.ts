import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody, record, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

const PROJECT_BODY = {
  villageId: "village-1",
  name: "Rampur footbridge",
  category: "bridge",
  fundSource: "district",
  sanctionedMinor: 500_000_00,
};

describe("fund monitoring routes", () => {
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

  async function sanction(overrides: Record<string, unknown> = {}): Promise<string> {
    const villageId = await village();
    const created = await post("/projects", { ...PROJECT_BODY, villageId, ...overrides });
    expect(created.status).toBe(201);
    return record(created.body)["projectId"] as string;
  }

  describe("POST /projects", () => {
    it("sanctions a project and answers 201 with its id", async () => {
      const villageId = await village();
      const response = await post("/projects", { ...PROJECT_BODY, villageId });

      expect(response.status).toBe(201);
      expect(record(response.body)["projectId"]).toBe("project-1");
    });

    it("rejects an unknown category with the domain's own message", async () => {
      const villageId = await village();
      const response = await post("/projects", { ...PROJECT_BODY, villageId, category: "spaceport" });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("invalid category: spaceport");
    });

    it("rejects an unknown fund source", async () => {
      const villageId = await village();
      const response = await post("/projects", { ...PROJECT_BODY, villageId, fundSource: "crypto" });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("invalid fundSource: crypto");
    });

    it("rejects a rupee float rather than truncating it to paise", async () => {
      const villageId = await village();
      const response = await post("/projects", { ...PROJECT_BODY, villageId, sanctionedMinor: 1500.75 });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("Money amount must be integer minor units");
    });

    it("rejects a missing field at the boundary", async () => {
      const response = await post("/projects", { name: "Rampur footbridge" });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("villageId must be a string");
    });

    it("answers 401 without a token", async () => {
      const response = await server.request("/projects", jsonBody(PROJECT_BODY));

      expect(response.status).toBe(401);
      expect(record(response.body)["error"]).toBe("missing bearer token");
    });
  });

  describe("POST /projects/:id/release", () => {
    it("releases funds and reports the running total and status", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/release`, { amountMinor: 200_000_00 });

      expect(response.status).toBe(201);
      expect(record(response.body)).toEqual({
        projectId,
        totalReleasedMinor: 200_000_00,
        status: "in_progress",
      });
    });

    it("refuses to release more than was sanctioned", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/release`, { amountMinor: 900_000_00 });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe(
        "released total 90000000 would exceed sanctioned 50000000",
      );
    });

    it("answers 404 for an unknown project", async () => {
      const response = await post("/projects/project-404/release", { amountMinor: 1 });

      expect(response.status).toBe(404);
      expect(record(response.body)["error"]).toBe("Project not found: project-404");
    });

    it("answers 401 without a token", async () => {
      const projectId = await sanction();
      const response = await server.request(
        `/projects/${projectId}/release`,
        jsonBody({ amountMinor: 1 }),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("POST /projects/:id/expenditure", () => {
    it("records an expenditure against released funds", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountMinor: 200_000_00 });

      const response = await post(`/projects/${projectId}/expenditure`, {
        amountMinor: 75_000_00,
        description: "Piling contractor",
        evidenceRef: "INV-77",
      });

      expect(response.status).toBe(201);
      expect(record(response.body)).toEqual({ projectId, totalSpentMinor: 75_000_00 });
    });

    it("refuses to spend more than has been released", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountMinor: 100_00 });

      const response = await post(`/projects/${projectId}/expenditure`, {
        amountMinor: 200_00,
        description: "Piling contractor",
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("spent total 20000 would exceed released 10000");
    });

    it("refuses an expenditure before any funds are released", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/expenditure`, {
        amountMinor: 100,
        description: "Piling contractor",
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe(
        "expenditures are only allowed while in_progress (status: sanctioned)",
      );
    });

    it("answers 401 without a token", async () => {
      const projectId = await sanction();
      const response = await server.request(`/projects/${projectId}/expenditure`, {
        ...jsonBody({ amountMinor: 1, description: "x" }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe("POST /projects/:id/complete and /verify", () => {
    it("walks a project through completion and village verification", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountMinor: 200_000_00 });

      const completed = await post(`/projects/${projectId}/complete`, {});
      expect(completed.status).toBe(200);
      expect(record(completed.body)).toEqual({ projectId, status: "completed" });

      const verified = await post(`/projects/${projectId}/verify`, {});
      expect(verified.status).toBe(200);
      expect(record(verified.body)).toEqual({ projectId, status: "verified" });
    });

    it("refuses to verify a project that was never completed", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/verify`, {});

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe(
        "only a completed project can be verified (status: sanctioned)",
      );
    });

    it("answers 401 without a token", async () => {
      const projectId = await sanction();
      const response = await server.request(`/projects/${projectId}/complete`, jsonBody({}));

      expect(response.status).toBe(401);
    });
  });

  describe("POST /projects/:id/detect-anomalies", () => {
    it("derives duplicate-funding evidence from the project register when the body omits it", async () => {
      const villageId = await village();
      const first = record((await post("/projects", { ...PROJECT_BODY, villageId })).body)[
        "projectId"
      ] as string;
      // A second ACTIVE bridge project in the same village is the rule's trigger.
      await post("/projects", { ...PROJECT_BODY, villageId, name: "Second bridge" });

      const response = await post(`/projects/${first}/detect-anomalies`, {});

      expect(response.status).toBe(200);
      const findings = record(response.body)["findings"] as Record<string, unknown>[];
      expect(findings.map((finding) => finding["type"])).toEqual(["duplicate_funding"]);
    });

    it("finds nothing for a lone project", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/detect-anomalies`, {});

      expect(response.status).toBe(200);
      expect(record(response.body)["findings"]).toEqual([]);
    });

    it("lets an explicitly empty otherActiveProjects suppress the derived evidence", async () => {
      const villageId = await village();
      const first = record((await post("/projects", { ...PROJECT_BODY, villageId })).body)[
        "projectId"
      ] as string;
      await post("/projects", { ...PROJECT_BODY, villageId, name: "Second bridge" });

      const response = await post(`/projects/${first}/detect-anomalies`, { otherActiveProjects: [] });

      expect(response.status).toBe(200);
      expect(record(response.body)["findings"]).toEqual([]);
    });

    it("rejects a non-positive stalledAfterDays with the domain message", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/detect-anomalies`, { stalledAfterDays: 0 });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("stalledAfterDays must be a positive number");
    });

    it("rejects a malformed otherActiveProjects entry at the boundary", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/detect-anomalies`, {
        otherActiveProjects: [{ villageId: "village-1" }],
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("otherActiveProjects[].category must be a string");
    });

    it("answers 401 without a token", async () => {
      const projectId = await sanction();
      const response = await server.request(`/projects/${projectId}/detect-anomalies`, jsonBody({}));

      expect(response.status).toBe(401);
    });
  });

  describe("GET /projects and GET /villages/:id/projects", () => {
    it("lists every project with its full operator view", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountMinor: 200_000_00 });
      await post(`/projects/${projectId}/expenditure`, {
        amountMinor: 50_000_00,
        description: "Piling contractor",
        evidenceRef: "INV-77",
      });

      const response = await server.request("/projects", { token: TOKEN });
      const projects = record(response.body)["projects"] as Record<string, unknown>[];

      expect(response.status).toBe(200);
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({
        id: projectId,
        name: "Rampur footbridge",
        category: "bridge",
        fundSource: "district",
        currency: "INR",
        sanctionedMinor: 500_000_00,
        releasedMinor: 200_000_00,
        spentMinor: 50_000_00,
        status: "in_progress",
      });
      expect(projects[0]!["expenditures"]).toEqual([
        {
          amountMinor: 50_000_00,
          currency: "INR",
          description: "Piling contractor",
          evidenceRef: "INV-77",
          spentAt: expect.any(String),
        },
      ]);
    });

    it("scopes the village list to that village's projects", async () => {
      const villageId = await village();
      await post("/projects", { ...PROJECT_BODY, villageId });

      const other = record((await post("/villages", { ...VILLAGE_BODY, name: "Sonpur" })).body)[
        "villageId"
      ] as string;
      await post("/projects", { ...PROJECT_BODY, villageId: other, name: "Sonpur road" });

      const response = await server.request(`/villages/${villageId}/projects`, { token: TOKEN });
      const projects = record(response.body)["projects"] as Record<string, unknown>[];

      expect(response.status).toBe(200);
      expect(record(response.body)["villageId"]).toBe(villageId);
      expect(projects.map((project) => project["name"])).toEqual(["Rampur footbridge"]);
    });

    it("answers an empty list, not a 404, for a village with no projects", async () => {
      const villageId = await village();
      const response = await server.request(`/villages/${villageId}/projects`, { token: TOKEN });

      expect(response.status).toBe(200);
      expect(record(response.body)["projects"]).toEqual([]);
    });

    it("answers 401 without a token", async () => {
      expect((await server.request("/projects")).status).toBe(401);
      expect((await server.request("/villages/village-1/projects")).status).toBe(401);
    });
  });
});
