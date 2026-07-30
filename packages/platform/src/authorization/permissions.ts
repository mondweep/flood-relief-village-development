import type { OwnableRecordType, UserRole } from "@afrip/shared-kernel";

/**
 * The policy table for ADR 0009 — which role may invoke which use case.
 *
 * It lives in `@afrip/platform` rather than in the shared kernel because it is
 * the only place that can see all nine contexts' use cases at once. The shared
 * kernel holds the *vocabulary* (roles, ownership, the refusal prefix); the
 * decision is here, next to the composition root that names the members it
 * decides about.
 *
 * Keys are `"<contextKey>.<memberName>"`, matching exactly the shape of
 * `Platform`. `permissions.test.ts` enumerates a real platform and asserts every
 * member has an entry, so a new use case cannot ship ungated: it fails the
 * completeness test before it fails in production.
 *
 * `admin` appears in no rule. It is allowed everywhere, and that is implemented
 * as a single check in `authorize-platform.ts` — listing it 48 times would be 48
 * chances to forget it.
 */

// ---------------------------------------------------------------------------
// Role sets
// ---------------------------------------------------------------------------

/**
 * Everyone who can hold an account. `admin` is omitted deliberately — it is
 * implicitly allowed everywhere (see `authorize-platform.ts`), so this list
 * plus that implicit grant is all five roles.
 */
const EVERYONE: readonly UserRole[] = ["district_officer", "ngo_coordinator", "village_committee", "citizen"];

/** Fund sanctioning, routing, verification: the state's side of the platform. */
const OFFICER: readonly UserRole[] = ["district_officer"];

/** Delivery work: the officer plus the NGO actually delivering it. */
const OFFICER_AND_NGO: readonly UserRole[] = ["district_officer", "ngo_coordinator"];

/** Anyone with a standing role in a village's recovery. */
const VILLAGE_WRITERS: readonly UserRole[] = ["district_officer", "ngo_coordinator", "village_committee"];

// ---------------------------------------------------------------------------
// Rule shape
// ---------------------------------------------------------------------------

export interface PermissionRule {
  /** Which roles may invoke this at all, regardless of ownership. */
  readonly roles: readonly UserRole[];
  /**
   * When set, a non-listed role may STILL invoke it if they own the record —
   * ownership widens rights (ADR 0009), never narrows them.
   */
  readonly ownable?: {
    readonly recordType: OwnableRecordType;
    /** Pulls the record id out of the use case's input. */
    readonly recordIdFrom: (input: unknown) => string | null;
  };
  /** Human phrasing for the refusal message, e.g. "register villages". */
  readonly operation: string;
  /**
   * Marks a member that is *introspected*, never invoked through the platform.
   * `socialMediaIntelligence.signalExtractor` is the only one: it is exposed so
   * `GET /health` can name the live ACL. Wrapping it would gate a call that
   * never happens, so the wrapper passes it through untouched and this flag
   * says so at the policy level rather than as a hardcoded key list in the
   * enforcement code.
   */
  readonly introspectionOnly?: boolean;
}

/**
 * Reads a string field off a use case's input, tolerating anything.
 *
 * Returns null rather than throwing when the field is missing or not a string:
 * a malformed input is the use case's problem to report (it validates and
 * returns a `Result`), and an authorization layer that threw on it would turn a
 * 400 into a 500. A null id simply means ownership cannot be established, which
 * falls through to a refusal — the safe direction.
 *
 * Branded ids (`VolunteerId`, `PlanId`, …) are plain strings at runtime, so this
 * reads them without a cast.
 */
function idFrom(field: string): (input: unknown) => string | null {
  return (input: unknown): string | null => {
    if (typeof input !== "object" || input === null) return null;
    const value = (input as Record<string, unknown>)[field];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
}

const OWNED_VILLAGE = { recordType: "village", recordIdFrom: idFrom("villageId") } as const;
const OWNED_ISSUE = { recordType: "issue", recordIdFrom: idFrom("issueId") } as const;
const OWNED_VOLUNTEER = { recordType: "volunteer", recordIdFrom: idFrom("volunteerId") } as const;
const OWNED_PLAN = { recordType: "plan", recordIdFrom: idFrom("planId") } as const;

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const PLATFORM_PERMISSIONS: Record<string, PermissionRule> = {
  // --- Village Registry ----------------------------------------------------
  "villageRegistry.registerVillage": { roles: VILLAGE_WRITERS, operation: "register villages" },
  "villageRegistry.recordDamageAssessment": { roles: VILLAGE_WRITERS, operation: "record damage assessments" },
  "villageRegistry.updateSeverity": { roles: VILLAGE_WRITERS, operation: "update village severity" },
  // The one edit path a citizen can reach, and only for a village they created.
  "villageRegistry.correctVillageProfile": {
    roles: VILLAGE_WRITERS,
    ownable: OWNED_VILLAGE,
    operation: "correct village profiles",
  },
  /**
   * ADMIN ONLY — an empty role list, which under `authorize-platform.ts` means
   * "nobody but admin", since admin is granted implicitly and never listed here.
   *
   * Declaring a village to be demonstration data removes it from every real
   * figure the platform publishes and is, by design, permanent (see
   * `Village.markAsDemonstration`). That is a statement about what the platform
   * as a whole is asserting, not a fact about one village's recovery, so it
   * belongs with whoever runs the platform rather than with the people
   * recording work in it. A district officer who could reach this could quietly
   * take a real village out of the reporting; no `ownable` clause either, for
   * the same reason — creating a record must not confer the right to declare it
   * fictional.
   */
  "villageRegistry.markAsDemonstration": {
    roles: [],
    operation: "mark villages as demonstration data",
  },
  "villageRegistry.getVillageProfile": { roles: EVERYONE, operation: "read village profiles" },
  "villageRegistry.listVillagesBySeverity": { roles: EVERYONE, operation: "list villages by severity" },

  // --- NGO Coordination ----------------------------------------------------
  "ngoCoordination.registerNgo": { roles: OFFICER, operation: "register NGOs" },
  "ngoCoordination.assignNgoToVillage": { roles: OFFICER, operation: "assign NGOs to villages" },
  "ngoCoordination.addCommitteeMember": { roles: OFFICER_AND_NGO, operation: "add committee members" },
  "ngoCoordination.listUnassignedVillages": { roles: EVERYONE, operation: "list unassigned villages" },

  // --- Recovery Intelligence -----------------------------------------------
  "recoveryIntelligence.upsertDimensionScores": { roles: OFFICER_AND_NGO, operation: "write recovery scores" },
  "recoveryIntelligence.getRecoveryIndex": { roles: EVERYONE, operation: "read the recovery index" },
  "recoveryIntelligence.getScoreHistory": { roles: EVERYONE, operation: "read recovery score history" },
  "recoveryIntelligence.recommendActions": { roles: EVERYONE, operation: "read recommended actions" },

  // --- Issue Tracking ------------------------------------------------------
  // Open to everyone on purpose: a citizen reporting a problem in their village
  // is the input the whole platform is built around.
  "issueTracking.reportIssue": { roles: EVERYONE, operation: "report issues" },
  "issueTracking.routeIssue": { roles: OFFICER_AND_NGO, operation: "route issues" },
  "issueTracking.startProgress": { roles: VILLAGE_WRITERS, ownable: OWNED_ISSUE, operation: "start work on issues" },
  "issueTracking.resolveIssue": { roles: VILLAGE_WRITERS, ownable: OWNED_ISSUE, operation: "resolve issues" },
  // NOT ownable, and that is the point: verification is a second pair of eyes.
  // If the reporter could verify their own resolution the step would certify
  // nothing. Only a district officer or the village committee may close the loop.
  "issueTracking.verifyResolution": {
    roles: ["district_officer", "village_committee"],
    operation: "verify issue resolutions",
  },

  // --- Beneficiary Registry ------------------------------------------------
  // The hole ADR 0009 exists to close. This registry holds the names, household
  // composition and aid history of widows and orphaned children; before this
  // table any authenticated caller could list it. District officers and NGO
  // coordinators only — no citizen, no village committee, and deliberately NO
  // `ownable` on any member: a citizen who somehow created a beneficiary record
  // must not thereby gain a way back into the registry. Ownership widening is a
  // convenience for editing your own village profile, not an access route to
  // protected personal data.
  "beneficiaryRegistry.registerBeneficiary": { roles: OFFICER_AND_NGO, operation: "register beneficiaries" },
  "beneficiaryRegistry.recordAid": { roles: OFFICER_AND_NGO, operation: "record aid distributions" },
  "beneficiaryRegistry.scheduleFollowUp": { roles: OFFICER_AND_NGO, operation: "schedule beneficiary follow-ups" },
  "beneficiaryRegistry.completeFollowUp": { roles: OFFICER_AND_NGO, operation: "complete beneficiary follow-ups" },
  "beneficiaryRegistry.listOverdueFollowUps": { roles: OFFICER_AND_NGO, operation: "list overdue follow-ups" },

  // --- Fund Monitoring -----------------------------------------------------
  "fundMonitoring.sanctionProject": { roles: OFFICER, operation: "sanction projects" },
  "fundMonitoring.releaseFunds": { roles: OFFICER, operation: "release funds" },
  "fundMonitoring.recordExpenditure": { roles: OFFICER_AND_NGO, operation: "record expenditure" },
  "fundMonitoring.completeProject": { roles: OFFICER_AND_NGO, operation: "complete projects" },
  "fundMonitoring.verifyProject": { roles: OFFICER, operation: "verify projects" },
  "fundMonitoring.detectAnomalies": { roles: OFFICER, operation: "run anomaly detection" },
  // Read-only, and open to everyone: where public money went is a product goal,
  // not a privilege. The write paths above are the guarded ones.
  "fundMonitoring.projectRepository": { roles: EVERYONE, operation: "read the project register" },

  // --- Volunteer Management ------------------------------------------------
  "volunteerManagement.registerVolunteer": { roles: EVERYONE, operation: "register volunteers" },
  // NOT `EVERYONE`, and the difference is the whole point of the `ownable`
  // clause. Ownership is consulted only AFTER the role grant fails, so granting
  // every role here would make the clause unreachable and the rule would read
  // "your own availability" while enforcing "anybody's" — a citizen could flip
  // any volunteer's availability at all. Officers and coordinators manage the
  // roster; a volunteer reaches their own record through ownership, which is
  // exactly the "edit entries they have made" requirement.
  "volunteerManagement.setAvailability": {
    roles: OFFICER_AND_NGO,
    ownable: OWNED_VOLUNTEER,
    operation: "set volunteer availability",
  },
  "volunteerManagement.assignVolunteer": { roles: OFFICER_AND_NGO, operation: "assign volunteers" },
  "volunteerManagement.logHours": { roles: OFFICER_AND_NGO, operation: "log volunteer hours" },
  "volunteerManagement.leaderboard": { roles: EVERYONE, operation: "read the volunteer leaderboard" },
  // Citizens excluded while `leaderboard` above is open to them. `GET /volunteers`
  // carries no phone or email today — the `Volunteer` aggregate has no such
  // field — but it does return every volunteer's NAME plus LOCATION and full
  // assignment history, which is a roster of who is where, and the leaderboard
  // projection is the aggregate view a citizen actually needs. If a contact
  // field is ever added to `VolunteerView`, this rule is already correct; do not
  // relax it.
  "volunteerManagement.volunteerRepository": { roles: VILLAGE_WRITERS, operation: "read the volunteer roster" },

  // --- Development Planning ------------------------------------------------
  "developmentPlanning.createPlan": { roles: VILLAGE_WRITERS, operation: "create development plans" },
  "developmentPlanning.addGoal": { roles: VILLAGE_WRITERS, ownable: OWNED_PLAN, operation: "add plan goals" },
  "developmentPlanning.addMilestone": {
    roles: VILLAGE_WRITERS,
    ownable: OWNED_PLAN,
    operation: "add plan milestones",
  },
  "developmentPlanning.completeMilestone": {
    roles: VILLAGE_WRITERS,
    ownable: OWNED_PLAN,
    operation: "complete plan milestones",
  },
  "developmentPlanning.getProgress": { roles: EVERYONE, operation: "read plan progress" },
  "developmentPlanning.planRepository": { roles: EVERYONE, operation: "read development plans" },

  // --- Social Media Intelligence -------------------------------------------
  // Citizen reports ARE the input to this context; gating it would empty it.
  "socialMediaIntelligence.ingestRawReport": { roles: EVERYONE, operation: "ingest raw reports" },
  "socialMediaIntelligence.evaluateAlerts": { roles: OFFICER, operation: "evaluate alerts" },
  // Unverified extracted signals and the alerts raised off them: wrong more
  // often than the registry is, and a false "embankment breach" alert visible to
  // the public is its own harm. Responders only.
  "socialMediaIntelligence.signalRepository": { roles: VILLAGE_WRITERS, operation: "read extracted signals" },
  "socialMediaIntelligence.alertRepository": { roles: VILLAGE_WRITERS, operation: "read smart alerts" },
  // Introspected by `GET /health` to name the live ACL, never invoked through
  // the platform by a route — see `introspectionOnly` above.
  "socialMediaIntelligence.signalExtractor": {
    roles: EVERYONE,
    introspectionOnly: true,
    operation: "inspect the signal extractor",
  },
};
