import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody, record, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

const RELIEF_REPORT = {
  rawText: "Relief distributed in Rampur village by Sewa Trust, food and water still needed",
  source: "whatsapp_field_report",
};

describe("social media intelligence routes", () => {
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

  async function ingest(body: unknown = RELIEF_REPORT): Promise<string> {
    const created = await post("/signals", body);
    expect(created.status).toBe(201);
    return record(created.body)["signalId"] as string;
  }

  describe("POST /signals", () => {
    it("ingests a raw report and answers 201 with the signal id", async () => {
      const response = await post("/signals", RELIEF_REPORT);

      expect(response.status).toBe(201);
      expect(record(response.body)["signalId"]).toBe("signal-1");
    });

    it("extracts village, NGO, activity and needs through the default keyword adapter", async () => {
      const signalId = await ingest();

      const response = await server.request(`/signals/${signalId}`, { token: TOKEN });
      const signal = record(response.body);

      expect(response.status).toBe(200);
      expect(signal["extracted"]).toEqual({
        villageName: "Rampur",
        ngoName: "Sewa Trust",
        activityType: "relief_distribution",
        needs: ["food", "water"],
      });
    });

    it("rejects an empty rawText with the domain message", async () => {
      const response = await post("/signals", { ...RELIEF_REPORT, rawText: "   " });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("rawText must not be empty");
    });

    it("rejects a source outside the enum", async () => {
      const response = await post("/signals", { ...RELIEF_REPORT, source: "carrier_pigeon" });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("invalid source: carrier_pigeon");
    });

    it("rejects a missing rawText at the boundary", async () => {
      const response = await post("/signals", { source: "news" });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("rawText must be a string");
    });

    it("answers 401 without a token", async () => {
      const response = await server.request("/signals", jsonBody(RELIEF_REPORT));

      expect(response.status).toBe(401);
      expect(record(response.body)["error"]).toBe("missing bearer token");
    });
  });

  describe("POST /signals/:id/evaluate", () => {
    it("raises alerts from explicitly supplied registry facts", async () => {
      const signalId = await ingest();

      const response = await post(`/signals/${signalId}/evaluate`, {
        registryFacts: { villageKnown: true, hasActiveNgo: false, recentAidTypes: ["food"] },
      });
      const alerts = record(response.body)["alerts"] as Record<string, unknown>[];

      expect(response.status).toBe(200);
      expect(alerts.map((alert) => alert["type"])).toEqual([
        "new_relief_activity",
        "duplicate_aid_likely",
        "no_ngo_assigned",
      ]);
    });

    it("derives the facts from the wired contexts when the body omits them", async () => {
      // "Rampur" is the name in VILLAGE_BODY, so the extracted village name matches
      // a registered village and the derived facts must say so.
      await post("/villages", VILLAGE_BODY);
      const signalId = await ingest();

      const response = await post(`/signals/${signalId}/evaluate`, {});
      const alerts = record(response.body)["alerts"] as Record<string, unknown>[];

      // Village known, no NGO assigned to it — the second rule is entirely derived.
      expect(response.status).toBe(200);
      expect(alerts.map((alert) => alert["type"])).toEqual([
        "new_relief_activity",
        "no_ngo_assigned",
      ]);
    });

    it("drops the no-NGO alert once the village has an active assignment", async () => {
      const villageId = record((await post("/villages", VILLAGE_BODY)).body)["villageId"] as string;
      const ngoId = record(
        (await post("/ngos", { name: "Sewa Trust", focusAreas: ["shelter"], capacity: 4 })).body,
      )["ngoId"] as string;
      await post(`/villages/${villageId}/assignment`, { ngoId });

      const signalId = await ingest();
      const response = await post(`/signals/${signalId}/evaluate`, {});
      const alerts = record(response.body)["alerts"] as Record<string, unknown>[];

      expect(alerts.map((alert) => alert["type"])).toEqual(["new_relief_activity"]);
    });

    it("treats an unregistered village name as unknown rather than guessing", async () => {
      const signalId = await ingest({
        rawText: "Relief distributed in Atlantis village",
        source: "news",
      });

      const response = await post(`/signals/${signalId}/evaluate`, {});
      const alerts = record(response.body)["alerts"] as Record<string, unknown>[];

      // villageKnown false, so the no-NGO rule cannot fire on a village we have
      // no record of — only the activity alert remains.
      expect(alerts.map((alert) => alert["type"])).toEqual(["new_relief_activity"]);
    });

    it("rejects a non-boolean villageKnown at the boundary", async () => {
      const signalId = await ingest();

      const response = await post(`/signals/${signalId}/evaluate`, {
        registryFacts: { villageKnown: "yes", hasActiveNgo: false },
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("registryFacts.villageKnown must be a boolean");
    });

    it("answers 404 for a signal that was never ingested", async () => {
      const response = await post("/signals/signal-404/evaluate", {});

      expect(response.status).toBe(404);
      expect(record(response.body)["error"]).toBe("signal not found: signal-404");
    });

    it("answers 401 without a token", async () => {
      const signalId = await ingest();
      const response = await server.request(`/signals/${signalId}/evaluate`, jsonBody({}));

      expect(response.status).toBe(401);
    });
  });

  describe("GET /signals and GET /alerts", () => {
    it("lists ingested signals with their extraction", async () => {
      await ingest();

      const response = await server.request("/signals", { token: TOKEN });
      const signals = record(response.body)["signals"] as Record<string, unknown>[];

      expect(response.status).toBe(200);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        id: "signal-1",
        source: "whatsapp_field_report",
        rawText: RELIEF_REPORT.rawText,
      });
    });

    it("lists alerts only after an evaluation has raised them", async () => {
      const signalId = await ingest();

      expect(record((await server.request("/alerts", { token: TOKEN })).body)["alerts"]).toEqual([]);

      await post(`/signals/${signalId}/evaluate`, {
        registryFacts: { villageKnown: true, hasActiveNgo: true, recentAidTypes: [] },
      });

      const response = await server.request("/alerts", { token: TOKEN });
      const alerts = record(response.body)["alerts"] as Record<string, unknown>[];

      expect(response.status).toBe(200);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        type: "new_relief_activity",
        signalId,
        villageName: "Rampur",
        details: "New relief activity reported",
      });
    });

    it("answers 401 without a token", async () => {
      expect((await server.request("/signals")).status).toBe(401);
      expect((await server.request("/alerts")).status).toBe(401);
    });
  });
});
