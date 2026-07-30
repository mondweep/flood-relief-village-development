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

  /**
   * Declaring a record to be DEMONSTRATION data — present so the platform can be
   * shown to someone, never a claim about a real place. See
   * `docs/incidents/2026-07-28-id-collision-data-loss.md`, whose closing lesson
   * is that fabricated records are harder to notice than deleted ones.
   */
  describe("POST /villages/:id/demonstration", () => {
    it("marks the village and shows the flag on every projection of it", async () => {
      const villageId = await village();

      const response = await post(`/villages/${villageId}/demonstration`, {
        reason: "seeded so the dashboard has something to show",
      });

      expect(response.status).toBe(200);
      expect(record(response.body)).toEqual({
        villageId,
        isDemonstration: true,
        alreadyMarked: false,
        reason: "seeded so the dashboard has something to show",
      });

      // The profile, the authenticated list and the public list all say so. A
      // reader must not have to know which endpoint carries the truth.
      expect(record((await get(`/villages/${villageId}`)).body)["isDemonstration"]).toBe(true);
      const listed = record((await get("/villages")).body)["villages"] as Record<string, unknown>[];
      expect(listed[0]?.["isDemonstration"]).toBe(true);
      const publicList = record((await server.request("/public/villages")).body)["villages"] as Record<
        string,
        unknown
      >[];
      expect(publicList[0]?.["isDemonstration"]).toBe(true);
    });

    it("registers villages as real, so the flag is only ever set deliberately", async () => {
      // Including when the registration body asks for it, which is what a stale
      // client or a copied curl command looks like.
      const created = await post("/villages", { ...VILLAGE_BODY, isDemonstration: true });
      const villageId = record(created.body)["villageId"] as string;

      expect(record((await get(`/villages/${villageId}`)).body)["isDemonstration"]).toBe(false);
    });

    it("requires a reason", async () => {
      const villageId = await village();

      const response = await post(`/villages/${villageId}/demonstration`, {});

      expect(response.status).toBe(400);
    });

    it("is idempotent, so re-running a marking script is safe", async () => {
      const villageId = await village();
      await post(`/villages/${villageId}/demonstration`, { reason: "seeded" });

      const again = await post(`/villages/${villageId}/demonstration`, { reason: "seeded" });

      expect(again.status).toBe(200);
      expect(record(again.body)["alreadyMarked"]).toBe(true);
      expect(record(again.body)["isDemonstration"]).toBe(true);
    });

    /**
     * There is no route that clears the flag, and this asserts it against the
     * live router rather than in prose. Clearing it would launder a fabricated
     * record into the real reporting; the repair path for a village flagged in
     * error is deliberately a superuser at the SQL console (migration 00008).
     */
    it("offers no way to clear the flag", async () => {
      const villageId = await village();
      await post(`/villages/${villageId}/demonstration`, { reason: "seeded" });

      const deleted = await server.request(`/villages/${villageId}/demonstration`, {
        method: "DELETE",
        token: TOKEN,
      });
      // 405: the path exists, the method does not — there is no unmark.
      expect(deleted.status).toBe(405);

      // Nor through the correction path, which amends the record of the WORLD
      // and not what kind of record this is. A real correction is applied here
      // (the name genuinely changes, so the request succeeds) with the flag
      // smuggled alongside it: the correction must land and the flag must not
      // move. A no-op correction would have been refused for the wrong reason
      // and would prove nothing.
      const corrected = await patch(`/villages/${villageId}/profile`, {
        isDemonstration: false,
        name: "Renamed Village",
        reason: "trying the back door",
      });
      expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
      expect(record(record(corrected.body)["profile"])["name"]).toBe("Renamed Village");
      expect(record(record(corrected.body)["profile"])["isDemonstration"]).toBe(true);

      expect(record((await get(`/villages/${villageId}`)).body)["isDemonstration"]).toBe(true);
    });

    it("puts the declaration on the village's timeline", async () => {
      const villageId = await village();
      await post(`/villages/${villageId}/demonstration`, { reason: "seeded for a walkthrough" });

      const history = record((await get(`/villages/${villageId}/history`)).body)[
        "history"
      ] as Record<string, unknown>[];

      // The audit log is what carries this entry, and it is only wired when the
      // deployment has one. Where it is absent the timeline is thinner, not wrong.
      const marked = history.filter((item) => item["kind"] === "demonstration-marked");
      for (const item of marked) {
        expect(String(item["summary"])).toMatch(/demonstration data/i);
      }
    });
  });

  describe("GET /villages/:id/history", () => {
    it("returns an empty timeline for a village with nothing recorded yet", async () => {
      const villageId = await village();

      const response = await get(`/villages/${villageId}/history`);

      expect(response.status).toBe(200);
      // `attributed: false` because this server runs with no identity (ADR
      // 0011 restricts the audit-derived half to admin and district_officer),
      // so the reader is told which view they got rather than left to assume
      // the emptiness is the whole truth.
      expect(response.body).toEqual({ villageId, history: [], attributed: false });
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
