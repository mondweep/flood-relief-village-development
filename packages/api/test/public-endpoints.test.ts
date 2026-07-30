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
  async function sanctionProject(village: string, sanctionedInr: number): Promise<string> {
    const created = await server.request("/projects", {
      ...jsonBody({
        villageId: village,
        name: "Rampur footbridge",
        category: "bridge",
        fundSource: "district",
        sanctionedInr,
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
      const projectId = await sanctionProject(rampur, 500_000);

      await server.request(`/projects/${projectId}/release`, {
        ...jsonBody({ amountInr: 200_000 }),
        token: TOKEN,
      });
      await server.request(`/projects/${projectId}/expenditure`, {
        ...jsonBody({ amountInr: 75_000, description: "Piling contractor", evidenceRef: "INV-77" }),
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
        sanctionedInr: 500_000,
        releasedInr: 200_000,
        spentInr: 75_000,
        status: "in_progress",
      });
    });

    it("withholds expenditure free text, which an operator could put a name into", async () => {
      const { rampur } = await seed();
      const projectId = await sanctionProject(rampur, 500_000);
      await server.request(`/projects/${projectId}/release`, {
        ...jsonBody({ amountInr: 200_000 }),
        token: TOKEN,
      });
      await server.request(`/projects/${projectId}/expenditure`, {
        ...jsonBody({ amountInr: 1_000, description: "Paid to Sunita Devi", evidenceRef: "RCPT-9" }),
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
        // A measured zero, and never omitted: a field that disappears when there
        // is nothing to report is a field the page stops rendering, and the
        // disclosure would then be missing on the day something IS seeded.
        demonstrationVillages: 0,
        // Money is the other way round: no project means no rupee has moved,
        // which is a measured zero rather than an absence of measurement.
        funds: {
          projectCount: 0,
          currency: "INR",
          sanctionedInr: 0,
          releasedInr: 0,
          spentInr: 0,
          anomalyCount: 0,
        },
      });
    });

    it("totals the fund ladder across every sanctioned project", async () => {
      const { rampur, sonpur } = await seed();
      const first = await sanctionProject(rampur, 500_000);
      await sanctionProject(sonpur, 300_000);

      await server.request(`/projects/${first}/release`, {
        ...jsonBody({ amountInr: 200_000 }),
        token: TOKEN,
      });
      await server.request(`/projects/${first}/expenditure`, {
        ...jsonBody({ amountInr: 60_000, description: "Piling contractor" }),
        token: TOKEN,
      });

      const funds = record(record((await server.request("/public/stats")).body)["funds"]);

      expect(funds).toEqual({
        projectCount: 2,
        currency: "INR",
        sanctionedInr: 800_000,
        releasedInr: 200_000,
        spentInr: 60_000,
        anomalyCount: 0,
      });
    });

    it("counts anomalies that Fund Monitoring has actually flagged", async () => {
      const { rampur } = await seed();
      // Two active bridge projects in one village is the duplicate-funding rule.
      const first = await sanctionProject(rampur, 500_000);
      await sanctionProject(rampur, 400_000);

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

  /**
   * DEMONSTRATION DATA AND THE PUBLISHED FIGURES.
   *
   * The rule these tests pin: a demonstration village is LISTED (labelled) and
   * COUNTED NOWHERE. Both halves matter, and each is the other's failure mode —
   * filtering the rows out would replace a labelled illustration with an
   * unexplained absence, while counting them would publish figures the platform
   * never measured. See `docs/incidents/2026-07-28-id-collision-data-loss.md`:
   * "fabrication is worse than deletion and harder to notice."
   */
  describe("demonstration villages", () => {
    async function markDemonstration(villageId: string): Promise<void> {
      const response = await server.request(`/villages/${villageId}/demonstration`, {
        ...jsonBody({ reason: "seeded so the platform can be shown" }),
        token: TOKEN,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }

    it("labels them in the public list rather than hiding them", async () => {
      const { rampur } = await seed();
      await markDemonstration(rampur);

      const villages = record((await server.request("/public/villages")).body)["villages"] as Array<
        Record<string, unknown>
      >;

      // Both still published — the flag is not sensitive, it is the disclosure.
      expect(villages).toHaveLength(2);
      const byId = new Map(villages.map((village) => [village["id"], village["isDemonstration"]]));
      expect(byId.get(rampur)).toBe(true);
      expect([...byId.values()].filter((flag) => flag === false)).toHaveLength(1);
    });

    it("counts none of them in any published figure, and says how many it left out", async () => {
      // `rampur` is the seeded village that carries the recovery index and the
      // active NGO, so marking it moves every figure at once.
      const { rampur } = await seed();
      await markDemonstration(rampur);

      const stats = record((await server.request("/public/stats")).body);

      expect(stats["totalVillages"]).toBe(1);
      expect(stats["bySeverity"]).toEqual({ critical: 1, severe: 0, moderate: 0, minor: 0 });
      expect(stats["villagesWithActiveNgo"]).toBe(0);
      // The one scored village was the demonstration one, so the honest answer
      // is "unknown" — NOT the composite that was made up to fill a screen.
      expect(stats["averageRecoveryComposite"]).toBeNull();
      // And the exclusion is stated, so "1 village" cannot be read as "we have
      // one village" when the registry holds two.
      expect(stats["demonstrationVillages"]).toBe(1);
    });

    it("reports zero real villages honestly when every village is a demonstration", async () => {
      const { rampur, sonpur } = await seed();
      await markDemonstration(rampur);
      await markDemonstration(sonpur);

      const stats = record((await server.request("/public/stats")).body);

      expect(stats["totalVillages"]).toBe(0);
      expect(stats["demonstrationVillages"]).toBe(2);
      expect(stats["bySeverity"]).toEqual({ critical: 0, severe: 0, moderate: 0, minor: 0 });
      expect(stats["averageRecoveryComposite"]).toBeNull();
      // The rows are still there to be looked at; it is the CLAIMS that are zero.
      expect(
        (record((await server.request("/public/villages")).body)["villages"] as unknown[]).length,
      ).toBe(2);
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
