import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/body.js";
import { jsonBody, record, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

describe("api server (over real HTTP)", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describe("health and readiness", () => {
    it("reports ok, persistence mode and version on GET /health", async () => {
      const response = await server.request("/health");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: "ok",
        persistence: "memory",
        version: "0.1.0",
        auth: "disabled",
      });
    });

    it("reports ready on GET /ready when the datastore is reachable", async () => {
      const response = await server.request("/ready");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: "ready", persistence: "memory" });
    });

    it("answers JSON content-type on every response", async () => {
      const response = await fetch(`${server.baseUrl}/health`);

      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    });
  });

  describe("village registry", () => {
    it("creates a village and reads it back", async () => {
      const created = await server.request("/villages", jsonBody(VILLAGE_BODY));
      expect(created.status).toBe(201);
      const villageId = record(created.body)["villageId"] as string;
      expect(villageId).toBe("village-1");

      const profile = await server.request(`/villages/${villageId}`);
      expect(profile.status).toBe(200);
      expect(record(profile.body)).toMatchObject({
        id: villageId,
        name: "Rampur",
        district: "Darbhanga",
        severity: "severe",
        damageAssessments: [],
      });
    });

    it("lists villages severity-first", async () => {
      await server.request("/villages", jsonBody(VILLAGE_BODY));
      await server.request("/villages", jsonBody({ ...VILLAGE_BODY, name: "Sonpur", severity: "critical" }));

      const listed = await server.request("/villages");

      expect(listed.status).toBe(200);
      const villages = record(listed.body)["villages"] as Array<Record<string, unknown>>;
      expect(villages.map((v) => v["name"])).toEqual(["Sonpur", "Rampur"]);
    });

    it("records a damage assessment and updates severity", async () => {
      const created = await server.request("/villages", jsonBody(VILLAGE_BODY));
      const villageId = record(created.body)["villageId"] as string;

      const assessed = await server.request(
        `/villages/${villageId}/damage-assessments`,
        jsonBody({
          housesDamaged: 40,
          schoolsDamaged: 1,
          healthCentresDamaged: 0,
          waterSourcesDamaged: 3,
          agricultureHectaresLost: 12.5,
          livestockLost: 8,
          notes: "post-monsoon survey",
        }),
      );

      expect(assessed.status).toBe(201);
      expect(record(assessed.body)["villageId"]).toBe(villageId);
      expect(record(record(assessed.body)["assessment"] as unknown)).toMatchObject({
        housesDamaged: 40,
        notes: "post-monsoon survey",
      });

      const patched = await server.request(`/villages/${villageId}/severity`, {
        method: "PATCH",
        body: JSON.stringify({ severity: "critical" }),
      });

      expect(patched.status).toBe(200);
      expect(patched.body).toEqual({ villageId, severity: "critical", previous: "severe" });
    });
  });

  describe("happy path: village -> lead NGO -> issue reported and routed", () => {
    it("routes an infrastructure issue to the village's lead NGO", async () => {
      const village = await server.request("/villages", jsonBody(VILLAGE_BODY));
      expect(village.status).toBe(201);
      const villageId = record(village.body)["villageId"] as string;

      const ngo = await server.request(
        "/ngos",
        jsonBody({ name: "Sahyog Trust", focusAreas: ["infrastructure", "water"], capacity: 3 }),
      );
      expect(ngo.status).toBe(201);
      const ngoId = record(ngo.body)["ngoId"] as string;

      const assignment = await server.request(`/villages/${villageId}/assignment`, jsonBody({ ngoId }));
      expect(assignment.status).toBe(201);
      expect(record(assignment.body)["assignmentId"]).toBe("assignment-1");

      const committee = await server.request(
        `/villages/${villageId}/committee`,
        jsonBody({ role: "leader", name: "Asha Devi", contact: "+91-99999-00000" }),
      );
      expect(committee.status).toBe(201);
      expect(record(committee.body)["assignmentId"]).toBe("assignment-1");

      const issue = await server.request(
        "/issues",
        jsonBody({
          villageId,
          category: "infrastructure",
          description: "The approach bridge collapsed",
          photoRefs: ["photo-1"],
          gps: { lat: 26.15, lng: 85.9 },
        }),
      );
      expect(issue.status).toBe(201);
      const issueId = record(issue.body)["issueId"] as string;

      const routed = await server.request(`/issues/${issueId}/route`, { method: "POST" });
      expect(routed.status).toBe(200);
      expect(routed.body).toEqual({ issueId, partyType: "lead_ngo", party: ngoId });

      const started = await server.request(`/issues/${issueId}/start`, { method: "POST" });
      expect(started.status).toBe(200);

      const resolved = await server.request(
        `/issues/${issueId}/resolve`,
        jsonBody({ resolutionNote: "Temporary bailey bridge installed" }),
      );
      expect(resolved.status).toBe(200);
      expect(resolved.body).toEqual({ issueId });
    });

    it("rejects resolving an issue that was never started", async () => {
      const issue = await server.request(
        "/issues",
        jsonBody({
          villageId: "village-1",
          category: "water",
          description: "Handpump contaminated",
          photoRefs: [],
          gps: { lat: 26.1, lng: 85.8 },
        }),
      );
      const issueId = record(issue.body)["issueId"] as string;

      const resolved = await server.request(`/issues/${issueId}/resolve`, jsonBody({ resolutionNote: "done" }));

      expect(resolved.status).toBe(400);
      expect(resolved.body).toEqual({ error: "cannot resolve an issue with status open" });
    });
  });

  describe("beneficiaries", () => {
    it("registers a beneficiary, records aid and lists the village roster without names", async () => {
      const village = await server.request("/villages", jsonBody(VILLAGE_BODY));
      const villageId = record(village.body)["villageId"] as string;

      const beneficiary = await server.request(
        "/beneficiaries",
        jsonBody({ villageId, name: "Sunita Kumari", category: "widow" }),
      );
      expect(beneficiary.status).toBe(201);
      const beneficiaryId = record(beneficiary.body)["beneficiaryId"] as string;

      const aid = await server.request(
        `/beneficiaries/${beneficiaryId}/aid`,
        jsonBody({ aidType: "food", providerId: "ngo-1", providerType: "ngo" }),
      );
      expect(aid.status).toBe(201);
      expect(record(aid.body)).toMatchObject({ beneficiaryId, duplicate: false });

      const roster = await server.request(`/villages/${villageId}/beneficiaries`);
      expect(roster.status).toBe(200);
      const rows = record(roster.body)["beneficiaries"] as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        {
          beneficiaryId,
          villageId,
          category: "widow",
          aidDeliveries: 1,
          lastAidAt: expect.any(String),
          duplicateFlags: 0,
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain("Sunita");
    });

    it("lists overdue follow-ups", async () => {
      const beneficiary = await server.request(
        "/beneficiaries",
        jsonBody({ villageId: "village-1", name: "Ram Prasad", category: "farmer" }),
      );
      const beneficiaryId = record(beneficiary.body)["beneficiaryId"] as string;

      const scheduled = await server.request(
        `/beneficiaries/${beneficiaryId}/follow-ups`,
        jsonBody({ dueAt: "2020-01-01T00:00:00.000Z" }),
      );
      expect(scheduled.status).toBe(201);
      const followUpId = record(scheduled.body)["followUpId"] as string;

      const overdue = await server.request("/follow-ups/overdue");
      expect(overdue.status).toBe(200);
      expect(record(overdue.body)["followUps"]).toEqual([
        {
          beneficiaryId,
          name: "Ram Prasad",
          villageId: "village-1",
          followUpId,
          dueAt: "2020-01-01T00:00:00.000Z",
        },
      ]);

      const completed = await server.request(
        `/beneficiaries/${beneficiaryId}/follow-ups/${followUpId}/complete`,
        { method: "POST" },
      );
      expect(completed.status).toBe(200);

      const after = await server.request("/follow-ups/overdue");
      expect(record(after.body)["followUps"]).toEqual([]);
    });
  });

  describe("recovery intelligence", () => {
    it("upserts dimension scores and reads the recovery index back", async () => {
      const village = await server.request("/villages", jsonBody(VILLAGE_BODY));
      const villageId = record(village.body)["villageId"] as string;

      const upserted = await server.request(`/villages/${villageId}/recovery-scores`, {
        method: "PUT",
        body: JSON.stringify({ scores: { water: 55, housing: 33 } }),
      });

      expect(upserted.status).toBe(200);
      expect(record(upserted.body)["villageId"]).toBe(villageId);
      expect(record(upserted.body)["composite"]).toBe(8);

      const index = await server.request(`/villages/${villageId}/recovery-index`);
      expect(index.status).toBe(200);
      expect(record(record(index.body)["scores"] as unknown)).toMatchObject({ water: 55, housing: 33 });
    });

    it("404s the recovery index of a village that has none", async () => {
      const response = await server.request("/villages/village-404/recovery-index");

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "No recovery index found for village: village-404" });
    });

    it("rejects an unknown dimension with 400", async () => {
      const response = await server.request("/villages/village-1/recovery-scores", {
        method: "PUT",
        body: JSON.stringify({ scores: { teleportation: 10 } }),
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "unknown dimension: teleportation" });
    });
  });

  describe("errors", () => {
    it("maps a domain validation failure to 400 with the message", async () => {
      const response = await server.request(
        "/villages",
        jsonBody({ ...VILLAGE_BODY, households: 100, affectedFamilies: 500 }),
      );

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "affectedFamilies must not exceed households" });
    });

    it("maps a missing body field to 400 at the boundary", async () => {
      const { geo: _geo, ...withoutGeo } = VILLAGE_BODY;

      const response = await server.request("/villages", jsonBody(withoutGeo));

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "geo must be an object with numeric lat and lng" });
    });

    // ADR 0012 §1: coordinates without provenance are the ambiguity the decision
    // removes, so a body that omits `geo.source` is rejected at the boundary
    // rather than defaulted to anything.
    it("maps coordinates without a source to 400 at the boundary", async () => {
      const { source: _source, ...geoWithoutSource } = VILLAGE_BODY.geo;

      const response = await server.request(
        "/villages",
        jsonBody({ ...VILLAGE_BODY, geo: geoWithoutSource }),
      );

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "geo.source must be a string" });
    });

    it("maps an unknown coordinate source to 400 from the aggregate", async () => {
      const response = await server.request(
        "/villages",
        jsonBody({ ...VILLAGE_BODY, geo: { ...VILLAGE_BODY.geo, source: "vibes" } }),
      );

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "geo.source must be one of device_gps, map_pin, geocoded, manual_entry",
      });
    });

    it("maps a not-found lookup to 404", async () => {
      const response = await server.request("/villages/village-does-not-exist");

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Village not found: village-does-not-exist" });
    });

    it("404s an unknown route", async () => {
      const response = await server.request("/no/such/thing");

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "not found: GET /no/such/thing" });
    });

    it("405s a known path with the wrong method", async () => {
      const response = await server.request("/health", { method: "POST", body: "{}" });

      expect(response.status).toBe(405);
      expect(response.body).toEqual({ error: "method not allowed: POST /health" });
    });

    it("400s malformed JSON without crashing the server", async () => {
      const response = await fetch(`${server.baseUrl}/villages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ this is not json",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "request body must be valid JSON" });

      // The process is still serving requests.
      const health = await server.request("/health");
      expect(health.status).toBe(200);
    });

    it("400s a JSON body that is not an object", async () => {
      const response = await server.request("/villages", jsonBody(["not", "an", "object"]));

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "request body must be a JSON object" });
    });

    it("413s a body over the size limit", async () => {
      const response = await fetch(`${server.baseUrl}/villages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blob: "x".repeat(MAX_BODY_BYTES + 1024) }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: `request body exceeds ${MAX_BODY_BYTES} bytes`,
      });
    });
  });

  describe("public transparency projection", () => {
    it("exposes villages with recovery scores and no beneficiary data", async () => {
      const village = await server.request("/villages", jsonBody(VILLAGE_BODY));
      const villageId = record(village.body)["villageId"] as string;
      await server.request(
        "/beneficiaries",
        jsonBody({ villageId, name: "Sunita Kumari", category: "widow" }),
      );
      await server.request(`/villages/${villageId}/recovery-scores`, {
        method: "PUT",
        body: JSON.stringify({ scores: { water: 55 } }),
      });

      const response = await server.request("/public/villages");

      expect(response.status).toBe(200);
      const villages = record(response.body)["villages"] as Array<Record<string, unknown>>;
      expect(villages).toHaveLength(1);
      expect(villages[0]).toMatchObject({
        id: villageId,
        name: "Rampur",
        district: "Darbhanga",
        severity: "severe",
        households: 260,
        affectedFamilies: 190,
      });
      expect(record(villages[0]?.["recovery"])["composite"]).toBe(5);
      expect(JSON.stringify(villages)).not.toContain("Sunita");
    });

    it("reports a null recovery block for a village with no index yet", async () => {
      await server.request("/villages", jsonBody(VILLAGE_BODY));

      const response = await server.request("/public/villages");
      const villages = record(response.body)["villages"] as Array<Record<string, unknown>>;

      expect(villages[0]?.["recovery"]).toBeNull();
    });
  });
});
