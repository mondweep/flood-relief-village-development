import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonBody, record, startTestServer, VILLAGE_BODY, type TestServer } from "./helpers.js";

const TOKEN = "s3cret-relief-token";

/**
 * Keys that must never appear anywhere in a `/public/*` payload, at any depth.
 *
 * Matched on the key *name*, not the value, because that is the check that
 * survives refactoring: a field called `contactPhone` is a leak whether or not
 * the fixture happened to populate it. `name` is exempt — village and project
 * names are place and infrastructure names, which is exactly what a
 * transparency feed is for — so the beneficiary-shaped variants are listed
 * explicitly instead.
 */
const FORBIDDEN_KEY_PATTERNS: readonly RegExp[] = [
  /beneficiar/i,
  /household(head|Head)/,
  /phone|mobile|contact|email/i,
  /aadhaar|aadhar|nationalid|national_id/i,
  /address|street|dob|birth/i,
  /firstname|lastname|fullname|surname|guardian|headOfFamily/i,
  /bankaccount|bank_account|ifsc|upi/i,
  /reportedby|reporter|assessor|officer|member/i,
];

function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      into.push(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

describe("public transparency endpoints", () => {
  let server: TestServer;

  beforeEach(async () => {
    // A token IS configured: these routes must be reachable in spite of it,
    // which is the whole point of the exemption list.
    server = await startTestServer({ apiToken: TOKEN });
  });

  afterEach(async () => {
    await server.close();
  });

  /** Registers two villages and gives one of them a recovery index and an NGO. */
  async function seed(): Promise<{ rampur: string; sonpur: string }> {
    const first = await server.request("/villages", { ...jsonBody(VILLAGE_BODY), token: TOKEN });
    const rampur = record(first.body)["villageId"] as string;

    const second = await server.request("/villages", {
      ...jsonBody({ ...VILLAGE_BODY, name: "Sonpur", severity: "critical" }),
      token: TOKEN,
    });
    const sonpur = record(second.body)["villageId"] as string;

    // A damage assessment publishes an event the recovery context turns into an index.
    await server.request(`/villages/${rampur}/damage-assessments`, {
      ...jsonBody({
        housesDamaged: 40,
        schoolsDamaged: 1,
        healthCentresDamaged: 0,
        waterSourcesDamaged: 3,
        agricultureHectaresLost: 12,
        livestockLost: 5,
      }),
      token: TOKEN,
    });

    const ngo = await server.request("/ngos", {
      ...jsonBody({ name: "Relief Trust", focusAreas: ["shelter"], capacity: 5 }),
      token: TOKEN,
    });
    expect(ngo.status).toBe(201);
    const ngoId = record(ngo.body)["ngoId"] as string;

    const assigned = await server.request(`/villages/${rampur}/assignment`, {
      ...jsonBody({ ngoId }),
      token: TOKEN,
    });
    expect(assigned.status).toBe(201);

    return { rampur, sonpur };
  }

  /** Sanctions one bridge project against a village and returns its id. */
  async function sanctionProject(village: string, sanctionedMinor: number): Promise<string> {
    const created = await server.request("/projects", {
      ...jsonBody({
        villageId: village,
        name: "Rampur footbridge",
        category: "bridge",
        fundSource: "district",
        sanctionedMinor,
      }),
      token: TOKEN,
    });
    expect(created.status).toBe(201);
    return record(created.body)["projectId"] as string;
  }

  describe("GET /public/funds", () => {
    it("answers 200 with a projects array and no credential", async () => {
      const response = await server.request("/public/funds");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ projects: [] });
    });

    it("is empty because nothing has been sanctioned, not because it failed", async () => {
      // Villages, NGOs and assessments exist; no project does. An empty feed here
      // is the honest report of an empty project register, not a dead route.
      await seed();
      const response = await server.request("/public/funds");

      const projects = record(response.body)["projects"];
      expect(Array.isArray(projects)).toBe(true);
      expect(projects).toEqual([]);
    });

    it("publishes a sanctioned project with its sanctioned/released/spent ladder", async () => {
      const { rampur } = await seed();
      const projectId = await sanctionProject(rampur, 500_000_00);

      await server.request(`/projects/${projectId}/release`, {
        ...jsonBody({ amountMinor: 200_000_00 }),
        token: TOKEN,
      });
      await server.request(`/projects/${projectId}/expenditure`, {
        ...jsonBody({ amountMinor: 75_000_00, description: "Piling contractor", evidenceRef: "INV-77" }),
        token: TOKEN,
      });

      const response = await server.request("/public/funds");
      const projects = record(response.body)["projects"] as Record<string, unknown>[];

      expect(response.status).toBe(200);
      expect(projects).toHaveLength(1);
      expect(projects[0]).toEqual({
        id: projectId,
        villageId: rampur,
        name: "Rampur footbridge",
        category: "bridge",
        fundSource: "district",
        currency: "INR",
        sanctionedMinor: 500_000_00,
        releasedMinor: 200_000_00,
        spentMinor: 75_000_00,
        status: "in_progress",
      });
    });

    it("withholds expenditure free text, which an operator could put a name into", async () => {
      const { rampur } = await seed();
      const projectId = await sanctionProject(rampur, 500_000_00);
      await server.request(`/projects/${projectId}/release`, {
        ...jsonBody({ amountMinor: 200_000_00 }),
        token: TOKEN,
      });
      await server.request(`/projects/${projectId}/expenditure`, {
        ...jsonBody({ amountMinor: 1_000_00, description: "Paid to Sunita Devi", evidenceRef: "RCPT-9" }),
        token: TOKEN,
      });

      const publicBody = JSON.stringify((await server.request("/public/funds")).body);
      expect(publicBody).not.toContain("Sunita");
      expect(publicBody).not.toContain("RCPT-9");
      expect(publicBody).not.toContain("expenditures");

      // The same detail IS available to an authenticated operator — the point is
      // the split, not that the platform forgets it.
      const authed = await server.request("/projects", { token: TOKEN });
      expect(JSON.stringify(authed.body)).toContain("Sunita");
    });
  });

  describe("GET /public/stats", () => {
    it("answers 200 with zeroed counts and a null average on an empty platform", async () => {
      const response = await server.request("/public/stats");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        totalVillages: 0,
        bySeverity: { critical: 0, severe: 0, moderate: 0, minor: 0 },
        villagesWithActiveNgo: 0,
        // Nothing scored is "unknown", never "zero recovery".
        averageRecoveryComposite: null,
        // Money is the other way round: no project means no rupee has moved,
        // which is a measured zero rather than an absence of measurement.
        funds: {
          projectCount: 0,
          currency: "INR",
          sanctionedMinor: 0,
          releasedMinor: 0,
          spentMinor: 0,
          anomalyCount: 0,
        },
      });
    });

    it("totals the fund ladder across every sanctioned project", async () => {
      const { rampur, sonpur } = await seed();
      const first = await sanctionProject(rampur, 500_000_00);
      await sanctionProject(sonpur, 300_000_00);

      await server.request(`/projects/${first}/release`, {
        ...jsonBody({ amountMinor: 200_000_00 }),
        token: TOKEN,
      });
      await server.request(`/projects/${first}/expenditure`, {
        ...jsonBody({ amountMinor: 60_000_00, description: "Piling contractor" }),
        token: TOKEN,
      });

      const funds = record(record((await server.request("/public/stats")).body)["funds"]);

      expect(funds).toEqual({
        projectCount: 2,
        currency: "INR",
        sanctionedMinor: 800_000_00,
        releasedMinor: 200_000_00,
        spentMinor: 60_000_00,
        anomalyCount: 0,
      });
    });

    it("counts anomalies that Fund Monitoring has actually flagged", async () => {
      const { rampur } = await seed();
      // Two active bridge projects in one village is the duplicate-funding rule.
      const first = await sanctionProject(rampur, 500_000_00);
      await sanctionProject(rampur, 400_000_00);

      const detected = await server.request(`/projects/${first}/detect-anomalies`, {
        ...jsonBody({}),
        token: TOKEN,
      });
      expect(detected.status).toBe(200);

      const funds = record(record((await server.request("/public/stats")).body)["funds"]);
      expect(funds["anomalyCount"]).toBe(1);
    });

    it("counts villages by severity and those with an active NGO assignment", async () => {
      await seed();

      const response = await server.request("/public/stats");
      const stats = record(response.body);

      expect(response.status).toBe(200);
      expect(stats["totalVillages"]).toBe(2);
      expect(stats["bySeverity"]).toEqual({ critical: 1, severe: 1, moderate: 0, minor: 0 });
      expect(stats["villagesWithActiveNgo"]).toBe(1);
    });

    it("averages the composite over only the villages that have an index", async () => {
      await seed();

      const stats = record((await server.request("/public/stats")).body);
      const villages = record((await server.request("/public/villages")).body)["villages"] as Array<
        Record<string, unknown>
      >;

      const scored = villages
        .map((village) => village["recovery"] as { composite: number } | null)
        .filter((recovery): recovery is { composite: number } => recovery !== null);

      // Exactly one village was assessed, so the mean is that village's composite —
      // the unscored village must not be averaged in as a zero.
      expect(scored).toHaveLength(1);
      expect(stats["averageRecoveryComposite"]).toBeCloseTo(scored[0]!.composite, 10);
      expect(stats["averageRecoveryComposite"]).not.toBeNull();
    });
  });

  describe("no personal data on any public route", () => {
    const publicPaths = ["/public/villages", "/public/funds", "/public/stats", "/public/config"];

    it("exposes no beneficiary-identifying key on any public response", async () => {
      const { rampur } = await seed();

      // A named, aided beneficiary exists in the platform. Not one byte of that
      // person may reach an unauthenticated caller.
      const registered = await server.request("/beneficiaries", {
        ...jsonBody({ villageId: rampur, name: "Sunita Devi", category: "widow" }),
        token: TOKEN,
      });
      expect(registered.status).toBe(201);
      const beneficiaryId = record(registered.body)["beneficiaryId"] as string;

      const aided = await server.request(`/beneficiaries/${beneficiaryId}/aid`, {
        ...jsonBody({ aidType: "food", providerId: "ngo-1", providerType: "ngo" }),
        token: TOKEN,
      });
      expect(aided.status).toBe(201);

      for (const path of publicPaths) {
        const response = await server.request(path);
        expect(response.status).toBe(200);

        const keys = collectKeys(response.body);
        for (const pattern of FORBIDDEN_KEY_PATTERNS) {
          const offending = keys.filter((key) => pattern.test(key));
          expect(offending, `${path} exposed key(s) matching ${String(pattern)}`).toEqual([]);
        }

        // Belt and braces: the seeded person's name must not appear as a value either.
        expect(JSON.stringify(response.body)).not.toContain("Sunita");
      }
    });
  });
});
