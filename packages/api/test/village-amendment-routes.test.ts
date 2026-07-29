import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody, record, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

/**
 * ADR 0013: correction (`PATCH /villages/:id/profile`) is a different act from
 * observation (`POST …/damage-assessments`) and transition (`PATCH …/severity`),
 * and the API keeps saying which one is happening.
 */
describe("village amendment and history routes", () => {
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

  async function patch(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    return server.request(path, { method: "PATCH", body: JSON.stringify(body), token: TOKEN });
  }

  async function get(path: string): Promise<{ status: number; body: unknown }> {
    return server.request(path, { token: TOKEN });
  }

  async function village(): Promise<string> {
    const created = await post("/villages", VILLAGE_BODY);
    return record(created.body)["villageId"] as string;
  }

  describe("PATCH /villages/:id/profile", () => {
    it("corrects the population and answers with the changed fields and the amended profile", async () => {
      const villageId = await village();

      const response = await patch(`/villages/${villageId}/profile`, {
        population: 1240,
        reason: "census figure was mistyped at registration",
      });

      expect(response.status).toBe(200);
      const body = record(response.body);
      expect(body["villageId"]).toBe(villageId);
      expect(body["reason"]).toBe("census figure was mistyped at registration");
      expect(body["changed"]).toEqual({ population: { from: 1200, to: 1240 } });
      expect(record(body["profile"])).toMatchObject({
        id: villageId,
        name: "Rampur",
        population: 1240,
        severity: "severe",
      });
    });

    it("persists the correction so the detail read shows the new value", async () => {
      const villageId = await village();
      await patch(`/villages/${villageId}/profile`, { population: 1240, reason: "re-surveyed" });

      const profile = await get(`/villages/${villageId}`);

      expect(record(profile.body)["population"]).toBe(1240);
    });

    it("carries before and after for every changed field, and omits the unchanged ones", async () => {
      const villageId = await village();

      const response = await patch(`/villages/${villageId}/profile`, {
        name: "Rampur", // unchanged
        district: "Madhubani", // changed
        population: 1240, // changed
        reason: "village was recorded under the wrong district",
      });

      expect(response.status).toBe(200);
      expect(record(response.body)["changed"]).toEqual({
        district: { from: "Darbhanga", to: "Madhubani" },
        population: { from: 1200, to: 1240 },
      });
    });

    it("400s a correction with an empty reason", async () => {
      const villageId = await village();

      const response = await patch(`/villages/${villageId}/profile`, { population: 1240, reason: "" });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "reason must not be empty" });
    });

    it("400s a correction with no reason field at all", async () => {
      const villageId = await village();

      const response = await patch(`/villages/${villageId}/profile`, { population: 1240 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "reason must be a string" });
    });

    it("400s a repeat of the same correction, which would change nothing", async () => {
      const villageId = await village();
      const first = await patch(`/villages/${villageId}/profile`, {
        population: 1240,
        reason: "census figure was mistyped",
      });
      expect(first.status).toBe(200);

      const second = await patch(`/villages/${villageId}/profile`, {
        population: 1240,
        reason: "census figure was mistyped",
      });

      expect(second.status).toBe(400);
      expect(second.body).toEqual({ error: "correction must change at least one field" });
    });

    it("400s with the domain's own message when the correction breaks affectedFamilies <= households", async () => {
      const villageId = await village();

      const response = await patch(`/villages/${villageId}/profile`, {
        affectedFamilies: 400,
        reason: "field team reported a higher figure",
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "affectedFamilies must not exceed households" });
    });

    it("404s a correction to an unknown village", async () => {
      const response = await patch("/villages/village-404/profile", {
        population: 1240,
        reason: "typo",
      });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Village not found: village-404" });
    });

    it("400s a malformed field before the use case sees it", async () => {
      const villageId = await village();

      const response = await patch(`/villages/${villageId}/profile`, {
        population: "twelve hundred",
        reason: "typo",
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "population must be a finite number when present" });
    });

    it("requires the bearer token", async () => {
      const villageId = await village();

      const response = await server.request(`/villages/${villageId}/profile`, {
        method: "PATCH",
        body: JSON.stringify({ population: 1240, reason: "typo" }),
      });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "missing bearer token", code: "token_missing" });
    });
  });

  describe("no generic overwrite route exists", () => {
    it("refuses PUT /villages/:id — correction and change must stay distinguishable (ADR 0013)", async () => {
      const villageId = await village();

      const response = await server.request(`/villages/${villageId}`, {
        method: "PUT",
        body: JSON.stringify({ ...VILLAGE_BODY, population: 1240 }),
        token: TOKEN,
      });

      expect(response.status).toBe(405);
    });
  });

  describe("GET /villages/:id/history", () => {
    it("returns an empty timeline for a village with nothing recorded yet", async () => {
      const villageId = await village();

      const response = await get(`/villages/${villageId}/history`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ villageId, history: [] });
    });

    it("returns damage assessments and recovery recalculations in chronological order", async () => {
      const villageId = await village();

      await post(`/villages/${villageId}/damage-assessments`, {
        housesDamaged: 40,
        schoolsDamaged: 1,
        healthCentresDamaged: 0,
        waterSourcesDamaged: 3,
        agricultureHectaresLost: 12.5,
        livestockLost: 8,
        notes: "post-monsoon survey",
      });
      const scored = await server.request(`/villages/${villageId}/recovery-scores`, {
        method: "PUT",
        body: JSON.stringify({ scores: { housing: 55, water: 40 } }),
        token: TOKEN,
      });
      expect(scored.status).toBe(200);

      const response = await get(`/villages/${villageId}/history`);

      expect(response.status).toBe(200);
      const history = record(response.body)["history"] as Array<Record<string, unknown>>;
      const kinds = history.map((item) => item["kind"]);
      expect(kinds.filter((kind) => kind === "damage-assessment")).toHaveLength(1);
      // Two recalculations: one triggered by the assessment, one by the explicit upsert.
      expect(kinds.filter((kind) => kind === "recovery-index")).toHaveLength(2);

      const timestamps = history.map((item) => Date.parse(item["at"] as string));
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));

      for (const item of history) {
        expect(typeof item["at"]).toBe("string");
        expect(typeof item["summary"]).toBe("string");
        expect(item).toHaveProperty("detail");
      }
    });

    it("carries the assessment itself as the item detail", async () => {
      const villageId = await village();
      await post(`/villages/${villageId}/damage-assessments`, {
        housesDamaged: 40,
        schoolsDamaged: 1,
        healthCentresDamaged: 0,
        waterSourcesDamaged: 3,
        agricultureHectaresLost: 12.5,
        livestockLost: 8,
        notes: "post-monsoon survey",
      });

      const response = await get(`/villages/${villageId}/history`);
      const history = record(response.body)["history"] as Array<Record<string, unknown>>;
      const assessment = history.find((item) => item["kind"] === "damage-assessment");

      expect(assessment?.["summary"]).toBe("Damage assessment recorded: 40 houses damaged");
      expect(record(assessment?.["detail"])).toMatchObject({
        housesDamaged: 40,
        notes: "post-monsoon survey",
      });
    });

    it("does not invent an entry for a severity transition, which nothing persists yet", async () => {
      const villageId = await village();
      await patch(`/villages/${villageId}/severity`, { severity: "critical" });

      const response = await get(`/villages/${villageId}/history`);

      expect(record(response.body)["history"]).toEqual([]);
    });

    it("404s an unknown village", async () => {
      const response = await get("/villages/village-404/history");

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Village not found: village-404" });
    });

    it("requires the bearer token", async () => {
      const villageId = await village();

      const response = await server.request(`/villages/${villageId}/history`);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "missing bearer token", code: "token_missing" });
    });
  });
});
