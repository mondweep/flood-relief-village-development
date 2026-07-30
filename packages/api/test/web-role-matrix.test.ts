import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLATFORM_PERMISSIONS } from "@afrip/platform";
import type { UserRole } from "@afrip/shared-kernel";
import { describe, expect, it } from "vitest";
import { FEEDBACK_ADMIN_ROLES } from "../src/routes/feedback.js";

/**
 * The Read me tab's role table must say what the server actually enforces.
 *
 * A published table of who-can-do-what is a promise, and this one is aimed at
 * people deciding whether to trust the platform with a register of widows and
 * orphaned children. A row that drifts out of step with `PLATFORM_PERMISSIONS`
 * does not merely mislead — it tells somebody their neighbours cannot see a list
 * that they can.
 *
 * So each row is checked against the real policy table by naming the permission
 * keys it summarises. The keys are the contract; the words in the cell are a
 * description of them.
 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../web/src/index.html", import.meta.url)),
  "utf8",
);

const ROLES: UserRole[] = [
  "citizen",
  "village_committee",
  "ngo_coordinator",
  "district_officer",
  "admin",
];

/** Row label -> the Yes/No cells, in the column order above. */
function matrix(): Record<string, string[]> {
  const table = /<table class="role-matrix">([\s\S]*?)<\/table>/.exec(PAGE);
  if (table === null) throw new Error("the role matrix is gone from the Read me tab");
  const out: Record<string, string[]> = {};
  for (const [, row] of table[1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const header = /<th scope="row">([\s\S]*?)<\/th>/.exec(row as string);
    if (header === null) continue;
    const label = (header[1] as string).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    out[label] = [...(row as string).matchAll(/<td>([^<]*)<\/td>/g)].map((m) => (m[1] as string).trim());
  }
  return out;
}

const MATRIX = matrix();

/** What the policy table says, for one permission key. Admin is never in a rule. */
function allows(key: string, role: UserRole): boolean {
  if (role === "admin") return true; // authorizePlatform admits admin before consulting rules
  const rule = (PLATFORM_PERMISSIONS as Record<string, { roles: readonly UserRole[] } | undefined>)[key];
  if (rule === undefined) throw new Error(`no such permission key: ${key}`);
  return rule.roles.includes(role);
}

describe("the published role matrix matches the enforced one", () => {
  it("was parsed at all — an empty table would pass every row vacuously", () => {
    expect(Object.keys(MATRIX).length).toBeGreaterThanOrEqual(10);
    for (const cells of Object.values(MATRIX)) expect(cells).toHaveLength(ROLES.length);
  });

  /**
   * Each row names the keys it summarises. A row is "Yes" for a role only when
   * EVERY key it claims is permitted — the table promises the whole activity,
   * not a fragment of it.
   */
  it.each([
    ["Read the public record — villages, severity, recovery, funds",
      ["villageRegistry.listVillagesBySeverity", "recoveryIntelligence.getRecoveryIndex"]],
    ["Report an issue in a village", ["issueTracking.reportIssue"]],
    ["Sign up as a volunteer", ["volunteerManagement.registerVolunteer"]],
    ["Send in a field report", ["socialMediaIntelligence.ingestRawReport"]],
    ["Register a village, record damage, set severity",
      ["villageRegistry.registerVillage", "villageRegistry.recordDamageAssessment",
       "villageRegistry.updateSeverity"]],
    ["Work an issue through to resolution",
      ["issueTracking.startProgress", "issueTracking.resolveIssue"]],
    ["Development plans, goals and milestones",
      ["developmentPlanning.createPlan", "developmentPlanning.addGoal",
       "developmentPlanning.addMilestone"]],
    ["The beneficiary register — names of widows and orphaned children",
      ["beneficiaryRegistry.registerBeneficiary", "beneficiaryRegistry.listOverdueFollowUps"]],
    ["Record aid given, and follow-ups",
      ["beneficiaryRegistry.recordAid", "beneficiaryRegistry.scheduleFollowUp"]],
    ["Assign volunteers and log their hours",
      ["volunteerManagement.assignVolunteer", "volunteerManagement.logHours"]],
    ["Register an NGO, assign the lead NGO to a village",
      ["ngoCoordination.registerNgo", "ngoCoordination.assignNgoToVillage"]],
    ["Sanction projects, release funds, run anomaly detection",
      ["fundMonitoring.sanctionProject", "fundMonitoring.releaseFunds",
       "fundMonitoring.detectAnomalies"]],
  ])("row %s says what the policy table says", (label, keys) => {
    const cells = MATRIX[label];
    expect(cells, `no row labelled "${label}" — was it reworded?`).toBeDefined();
    ROLES.forEach((role, column) => {
      const permitted = (keys as string[]).every((key) => allows(key, role));
      expect(cells?.[column], `${label} / ${role}`).toBe(permitted ? "Yes" : "No");
    });
  });

  /**
   * The two admin-only rows are enforced in route handlers rather than in the
   * policy table (ADR 0016 argues why feedback is not a bounded context), so
   * they are checked against the exported role lists instead.
   */
  it("row about the feedback queue matches FEEDBACK_ADMIN_ROLES", () => {
    const cells = MATRIX["Read reported bugs and triage them"];
    expect(cells).toBeDefined();
    ROLES.forEach((role, column) => {
      const permitted = FEEDBACK_ADMIN_ROLES.includes(role);
      expect(cells?.[column], `feedback queue / ${role}`).toBe(permitted ? "Yes" : "No");
    });
  });

  it("row about demonstration data is admin alone", () => {
    const cells = MATRIX["Mark records as demonstration data"];
    expect(cells).toBeDefined();
    ROLES.forEach((role, column) => {
      expect(cells?.[column]).toBe(allows("villageRegistry.markAsDemonstration", role) ? "Yes" : "No");
    });
  });

  /**
   * The counts in the prose beneath the table. Written out because "roughly 14
   * things" is the sentence a reader actually takes away, and a stale number
   * there is a lie in the most-read part of the section.
   */
  it.each([
    ["citizen", 14],
    ["village_committee", 28],
    ["ngo_coordinator", 40],
  ])("claims the right number of capabilities for %s", (role, claimed) => {
    const actual = Object.values(
      PLATFORM_PERMISSIONS as Record<string, { roles: readonly UserRole[] }>,
    ).filter((rule) => rule.roles.includes(role as UserRole)).length;
    expect(actual, `the Read me says ${role} can do ${claimed} things`).toBe(claimed);
    expect(PAGE).toContain(String(claimed));
  });

  /**
   * The sentence that stops the table being read as the whole truth. ADR 0009
   * lets ownership widen rights per record — a citizen who reports an issue may
   * resolve it — and the table cannot express that, so it has to say so.
   */
  it("says that ownership widens rights beyond the table", () => {
    const section = /<section class="section" aria-labelledby="h-rm-roles">[\s\S]*?<\/section>/.exec(PAGE);
    expect(section?.[0] ?? "").toMatch(/what you created/i);
  });

  it("says what an administrator actually is", () => {
    // "A role that is not checked" rather than "a role with every permission" —
    // the distinction is why admin appears in no rule and why the list of
    // administrators lives in version control.
    const section = /<section class="section" aria-labelledby="h-rm-roles">[\s\S]*?<\/section>/.exec(PAGE);
    expect(section?.[0] ?? "").toMatch(/not checked/i);
  });
});
