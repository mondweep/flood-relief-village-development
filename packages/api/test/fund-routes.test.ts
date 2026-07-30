import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody, record, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

const PROJECT_BODY = {
  villageId: "village-1",
  name: "Rampur footbridge",
  category: "bridge",
  fundSource: "district",
  sanctionedInr: 500_000,
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

    it("accepts paise as the second decimal of a rupee amount", async () => {
      const villageId = await village();
      const response = await post("/projects", {
        ...PROJECT_BODY,
        villageId,
        sanctionedInr: 1500.75,
      });

      expect(response.status).toBe(201);

      const listed = await server.request("/projects", { token: TOKEN });
      const projects = record(listed.body)["projects"] as Record<string, unknown>[];
      expect(projects[0]!["sanctionedInr"]).toBe(1500.75);
    });

    /**
     * `19.99` is `1998.9999999999998` once multiplied by 100. Asserting the
     * figure survives the round trip EXACTLY is the point — a boundary that
     * truncated instead of rounding would book ₹19.98 and nobody would notice
     * until the ledger was a paisa short per project.
     */
    it.each([19.99, 0.01, 1234567.89, 0.1 + 0.2])(
      "round-trips the awkward decimal %p without losing a paisa",
      async (sanctionedInr) => {
        const villageId = await village();
        const created = await post("/projects", { ...PROJECT_BODY, villageId, sanctionedInr });
        expect(created.status).toBe(201);

        const listed = await server.request("/projects", { token: TOKEN });
        const projects = record(listed.body)["projects"] as Record<string, unknown>[];
        expect(projects[0]!["sanctionedInr"]).toBe(Number(sanctionedInr.toFixed(2)));
      },
    );

    it("rejects more precision than a rupee has, rather than rounding it away", async () => {
      const villageId = await village();
      const response = await post("/projects", { ...PROJECT_BODY, villageId, sanctionedInr: 1234.567 });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe(
        "sanctionedInr: Money amount cannot have more than 2 decimal places",
      );

      // 0.145 is the one that matters: bare Math.round(0.145 * 100) is 14, so a
      // paisa would vanish silently instead of the caller being told.
      const sneaky = await post("/projects", { ...PROJECT_BODY, villageId, sanctionedInr: 0.145 });
      expect(sneaky.status).toBe(400);
    });

    it("rejects an amount too large to hold as exact paise", async () => {
      const villageId = await village();
      const response = await post("/projects", {
        ...PROJECT_BODY,
        villageId,
        sanctionedInr: Number.MAX_SAFE_INTEGER,
      });

      expect(response.status).toBe(400);
      expect(String(record(response.body)["error"])).toContain("sanctionedInr:");
    });

    it("rejects a non-numeric amount at the boundary", async () => {
      const villageId = await village();
      const response = await post("/projects", { ...PROJECT_BODY, villageId, sanctionedInr: "50000" });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("sanctionedInr must be a finite number");
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
      const response = await post(`/projects/${projectId}/release`, { amountInr: 200_000 });

      expect(response.status).toBe(201);
      expect(record(response.body)).toEqual({
        projectId,
        currency: "INR",
        totalReleasedInr: 200_000,
        status: "in_progress",
      });
    });

    it("refuses to release more than was sanctioned", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/release`, { amountInr: 900_000 });

      expect(response.status).toBe(400);
      // The ladder is still enforced in integer paise INSIDE the aggregate —
      // that is the whole point of Money holding integers — but the message
      // quotes the unit the caller used. Telling someone who sent ₹900,000 that
      // "90000000 would exceed 50000000" reads as a hundredfold error in the
      // platform rather than as their own overspend.
      expect(record(response.body)["error"]).toBe(
        "released total 900000 would exceed sanctioned 500000",
      );
    });

    it("rejects a release with more precision than a rupee has", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/release`, { amountInr: 100.005 });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe(
        "amountInr: Money amount cannot have more than 2 decimal places",
      );
    });

    it("answers 404 for an unknown project", async () => {
      const response = await post("/projects/project-404/release", { amountInr: 1 });

      expect(response.status).toBe(404);
      expect(record(response.body)["error"]).toBe("Project not found: project-404");
    });

    it("answers 401 without a token", async () => {
      const projectId = await sanction();
      const response = await server.request(
        `/projects/${projectId}/release`,
        jsonBody({ amountInr: 1 }),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("POST /projects/:id/expenditure", () => {
    it("records an expenditure against released funds", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountInr: 200_000 });

      const response = await post(`/projects/${projectId}/expenditure`, {
        amountInr: 75_000,
        description: "Piling contractor",
        evidenceRef: "INV-77",
      });

      expect(response.status).toBe(201);
      expect(record(response.body)).toEqual({ projectId, currency: "INR", totalSpentInr: 75_000 });
    });

    /**
     * Three expenditures whose rupee values do not add up cleanly in floats:
     * 0.07 + 0.02 + 0.01 is 0.10000000000000002 as doubles. The running total
     * must be exactly 0.1, because the aggregate adds 7 + 2 + 1 paise.
     */
    it("keeps the running total exact across expenditures that float arithmetic would drift on", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountInr: 1 });

      for (const amountInr of [0.07, 0.02, 0.01]) {
        const posted = await post(`/projects/${projectId}/expenditure`, {
          amountInr,
          description: "Sundries",
        });
        expect(posted.status).toBe(201);
      }

      const listed = await server.request("/projects", { token: TOKEN });
      const projects = record(listed.body)["projects"] as Record<string, unknown>[];
      expect(projects[0]!["spentInr"]).toBe(0.1);
      expect(
        (projects[0]!["expenditures"] as Record<string, unknown>[]).map((e) => e["amountInr"]),
      ).toEqual([0.07, 0.02, 0.01]);
    });

    it("rejects an expenditure with more precision than a rupee has", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountInr: 200_000 });

      const response = await post(`/projects/${projectId}/expenditure`, {
        amountInr: 12.3456,
        description: "Piling contractor",
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe(
        "amountInr: Money amount cannot have more than 2 decimal places",
      );
    });

    it("refuses to spend more than has been released", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountInr: 100 });

      const response = await post(`/projects/${projectId}/expenditure`, {
        amountInr: 200,
        description: "Piling contractor",
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("spent total 200 would exceed released 100");
    });

    it("refuses an expenditure before any funds are released", async () => {
      const projectId = await sanction();
      const response = await post(`/projects/${projectId}/expenditure`, {
        amountInr: 1,
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
        ...jsonBody({ amountInr: 1, description: "x" }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe("POST /projects/:id/complete and /verify", () => {
    it("walks a project through completion and village verification", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountInr: 200_000 });

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

    it("takes comparable spend in rupees and refuses excess precision there too", async () => {
      const projectId = await sanction();
      await post(`/projects/${projectId}/release`, { amountInr: 200_000 });
      await post(`/projects/${projectId}/expenditure`, {
        amountInr: 150_000,
        description: "Piling contractor",
      });

      // Median of the comparables is ₹10,000, so 1.5x is ₹15,000 and a
      // ₹150,000 spend is far over it. Sent as rupees, not paise.
      const flagged = await post(`/projects/${projectId}/detect-anomalies`, {
        comparableSpentInr: [9_000, 10_000, 11_000],
        otherActiveProjects: [],
      });
      expect(flagged.status).toBe(200);
      const findings = record(flagged.body)["findings"] as Record<string, unknown>[];
      expect(findings.map((finding) => finding["type"])).toContain("overspend_vs_comparable");

      const tooPrecise = await post(`/projects/${projectId}/detect-anomalies`, {
        comparableSpentInr: [9_000, 10_000.123],
      });
      expect(tooPrecise.status).toBe(400);
      expect(record(tooPrecise.body)["error"]).toBe(
        "comparableSpentInr[]: Money amount cannot have more than 2 decimal places",
      );
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
      await post(`/projects/${projectId}/release`, { amountInr: 200_000 });
      await post(`/projects/${projectId}/expenditure`, {
        amountInr: 50_000,
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
        sanctionedInr: 500_000,
        releasedInr: 200_000,
        spentInr: 50_000,
        status: "in_progress",
      });
      expect(projects[0]!["expenditures"]).toEqual([
        {
          amountInr: 50_000,
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
