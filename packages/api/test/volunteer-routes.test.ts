import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody, record, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

const VOLUNTEER_BODY = {
  name: "Anil Das",
  skills: ["first-aid", "boat-handling"],
  languages: ["as", "hi"],
  location: "Dhemaji",
};

describe("volunteer management routes", () => {
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

  async function registerVolunteer(overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await post("/volunteers", { ...VOLUNTEER_BODY, ...overrides });
    expect(created.status).toBe(201);
    return record(created.body)["volunteerId"] as string;
  }

  async function village(): Promise<string> {
    const created = await post("/villages", VILLAGE_BODY);
    return record(created.body)["villageId"] as string;
  }

  describe("POST /volunteers", () => {
    it("registers a volunteer and answers 201 with the id", async () => {
      const response = await post("/volunteers", VOLUNTEER_BODY);

      expect(response.status).toBe(201);
      expect(record(response.body)["volunteerId"]).toBe("volunteer-1");
    });

    it("rejects an empty name with the domain's own message", async () => {
      const response = await post("/volunteers", { ...VOLUNTEER_BODY, name: "  " });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("name must not be empty");
    });

    it("rejects a non-array skills field at the boundary", async () => {
      const response = await post("/volunteers", { ...VOLUNTEER_BODY, skills: "first-aid" });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("skills must be an array of strings");
    });

    it("answers 401 without a token", async () => {
      const response = await server.request("/volunteers", jsonBody(VOLUNTEER_BODY));

      expect(response.status).toBe(401);
      expect(record(response.body)["error"]).toBe("missing bearer token");
    });
  });

  describe("PATCH /volunteers/:id/availability", () => {
    it("flips availability and reports the previous value", async () => {
      const volunteerId = await registerVolunteer();
      const response = await patch(`/volunteers/${volunteerId}/availability`, {
        availability: "unavailable",
      });

      expect(response.status).toBe(200);
      expect(record(response.body)).toEqual({ volunteerId, previousAvailability: "available" });
    });

    it("rejects an availability outside the enum", async () => {
      const volunteerId = await registerVolunteer();
      const response = await patch(`/volunteers/${volunteerId}/availability`, {
        availability: "maybe",
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("availability must be 'available' or 'unavailable'");
    });

    it("answers 404 for an unknown volunteer", async () => {
      const response = await patch("/volunteers/volunteer-404/availability", {
        availability: "unavailable",
      });

      expect(response.status).toBe(404);
      expect(record(response.body)["error"]).toBe("volunteer not found");
    });

    it("answers 401 without a token", async () => {
      const volunteerId = await registerVolunteer();
      const response = await server.request(`/volunteers/${volunteerId}/availability`, {
        method: "PATCH",
        body: JSON.stringify({ availability: "unavailable" }),
      });

      expect(response.status).toBe(401);
    });
  });

  describe("POST /volunteers/:id/assignments", () => {
    it("assigns an available volunteer to a village task", async () => {
      const volunteerId = await registerVolunteer();
      const villageId = await village();

      const response = await post(`/volunteers/${volunteerId}/assignments`, {
        villageId,
        task: "Relief distribution",
      });

      expect(response.status).toBe(201);
      expect(record(response.body)).toEqual({
        volunteerId,
        assignmentId: "volunteer-assignment-1",
      });
    });

    it("refuses to assign a volunteer who has marked themselves unavailable", async () => {
      const volunteerId = await registerVolunteer();
      const villageId = await village();
      await patch(`/volunteers/${volunteerId}/availability`, { availability: "unavailable" });

      const response = await post(`/volunteers/${volunteerId}/assignments`, {
        villageId,
        task: "Relief distribution",
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("volunteer is not available");
    });

    it("rejects a missing task at the boundary", async () => {
      const volunteerId = await registerVolunteer();
      const villageId = await village();

      const response = await post(`/volunteers/${volunteerId}/assignments`, { villageId });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("task must be a string");
    });

    it("answers 401 without a token", async () => {
      const volunteerId = await registerVolunteer();
      const response = await server.request(
        `/volunteers/${volunteerId}/assignments`,
        jsonBody({ villageId: "village-1", task: "Relief distribution" }),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("POST /volunteers/:id/hours", () => {
    it("logs hours against an assignment", async () => {
      const volunteerId = await registerVolunteer();
      const villageId = await village();
      const assigned = await post(`/volunteers/${volunteerId}/assignments`, {
        villageId,
        task: "Relief distribution",
      });
      const assignmentId = record(assigned.body)["assignmentId"] as string;

      const response = await post(`/volunteers/${volunteerId}/hours`, { assignmentId, hours: 6 });

      expect(response.status).toBe(201);
      expect(record(response.body)).toEqual({ volunteerId, assignmentId, hoursLogged: 6 });
    });

    it("rejects non-positive hours with the domain message", async () => {
      const volunteerId = await registerVolunteer();
      const response = await post(`/volunteers/${volunteerId}/hours`, {
        assignmentId: "volunteer-assignment-1",
        hours: 0,
      });

      expect(response.status).toBe(400);
      expect(record(response.body)["error"]).toBe("hours must be greater than 0");
    });

    it("answers 404 for hours logged against an unknown assignment", async () => {
      const volunteerId = await registerVolunteer();
      const response = await post(`/volunteers/${volunteerId}/hours`, {
        assignmentId: "nope",
        hours: 3,
      });

      expect(response.status).toBe(404);
      expect(record(response.body)["error"]).toBe("assignment not found");
    });

    it("answers 401 without a token", async () => {
      const volunteerId = await registerVolunteer();
      const response = await server.request(
        `/volunteers/${volunteerId}/hours`,
        jsonBody({ assignmentId: "a", hours: 1 }),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("GET /volunteers and GET /volunteers/leaderboard", () => {
    it("lists volunteers with their skills, availability and running hours", async () => {
      const volunteerId = await registerVolunteer();
      const villageId = await village();
      const assigned = await post(`/volunteers/${volunteerId}/assignments`, {
        villageId,
        task: "Relief distribution",
      });
      await post(`/volunteers/${volunteerId}/hours`, {
        assignmentId: record(assigned.body)["assignmentId"],
        hours: 6,
      });

      const response = await server.request("/volunteers", { token: TOKEN });
      const volunteers = record(response.body)["volunteers"] as Record<string, unknown>[];

      expect(response.status).toBe(200);
      expect(volunteers).toHaveLength(1);
      expect(volunteers[0]).toMatchObject({
        id: volunteerId,
        name: "Anil Das",
        skills: ["first-aid", "boat-handling"],
        languages: ["as", "hi"],
        location: "Dhemaji",
        availability: "available",
        totalHours: 6,
      });
      expect(volunteers[0]!["assignments"]).toHaveLength(1);
    });

    it("ranks the leaderboard by hours, highest first", async () => {
      const villageId = await village();
      const busy = await registerVolunteer({ name: "Anil Das" });
      const quiet = await registerVolunteer({ name: "Rina Boro" });

      for (const [volunteerId, hours] of [
        [busy, 9],
        [quiet, 2],
      ] as const) {
        const assigned = await post(`/volunteers/${volunteerId}/assignments`, {
          villageId,
          task: "Relief distribution",
        });
        await post(`/volunteers/${volunteerId}/hours`, {
          assignmentId: record(assigned.body)["assignmentId"],
          hours,
        });
      }

      const response = await server.request("/volunteers/leaderboard", { token: TOKEN });

      expect(response.status).toBe(200);
      expect(record(response.body)["entries"]).toEqual([
        { volunteerId: busy, name: "Anil Das", totalHours: 9 },
        { volunteerId: quiet, name: "Rina Boro", totalHours: 2 },
      ]);
    });

    it("answers an empty leaderboard rather than 404 when nobody has registered", async () => {
      const response = await server.request("/volunteers/leaderboard", { token: TOKEN });

      expect(response.status).toBe(200);
      expect(record(response.body)["entries"]).toEqual([]);
    });

    it("answers 401 without a token", async () => {
      expect((await server.request("/volunteers")).status).toBe(401);
      expect((await server.request("/volunteers/leaderboard")).status).toBe(401);
    });
  });
});
