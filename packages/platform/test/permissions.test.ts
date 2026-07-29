import { describe, expect, it } from "vitest";
import { USER_ROLES, isUserRole, OWNABLE_RECORD_TYPES } from "@afrip/shared-kernel";
import { createPlatform, PLATFORM_PERMISSIONS } from "@afrip/platform";

/**
 * The policy table is data, and data rots quietly. These tests are the check
 * that it still describes the platform it claims to describe.
 */

/** Keys on `Platform` that are infrastructure, not a bounded context. */
const NON_CONTEXT_KEYS = new Set(["bus", "eventPublisher", "composition"]);

/**
 * Enumerates a REAL platform rather than a hardcoded list. That is the whole
 * point: a list would have to be updated by the same person who forgot to add
 * the rule.
 */
function platformMemberKeys(): string[] {
  const platform = createPlatform();
  const keys: string[] = [];
  for (const [contextKey, contextValue] of Object.entries(platform)) {
    if (NON_CONTEXT_KEYS.has(contextKey)) continue;
    for (const memberName of Object.keys(contextValue as Record<string, unknown>)) {
      keys.push(`${contextKey}.${memberName}`);
    }
  }
  return keys;
}

describe("PLATFORM_PERMISSIONS completeness", () => {
  it("covers every member of every context on a freshly created platform", () => {
    const missing = platformMemberKeys().filter((key) => PLATFORM_PERMISSIONS[key] === undefined);
    // Named explicitly in the failure so the fix is obvious: add a rule for these.
    expect(missing).toEqual([]);
  });

  it("has no rule for a member that no longer exists", () => {
    const live = new Set(platformMemberKeys());
    const stale = Object.keys(PLATFORM_PERMISSIONS).filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });

  it("covers all nine bounded contexts", () => {
    const contexts = new Set(platformMemberKeys().map((key) => key.split(".")[0]));
    expect(contexts.size).toBe(9);
  });

  it("gates exactly the 48 members the platform exposes", () => {
    // A count, so adding a member without a rule fails here too even if the
    // completeness filter above is ever weakened.
    expect(platformMemberKeys()).toHaveLength(48);
    expect(Object.keys(PLATFORM_PERMISSIONS)).toHaveLength(48);
  });
});

describe("PLATFORM_PERMISSIONS shape", () => {
  it("names only real roles, and never lists admin", () => {
    for (const [key, rule] of Object.entries(PLATFORM_PERMISSIONS)) {
      for (const role of rule.roles) {
        expect(isUserRole(role), `${key} names unknown role ${role}`).toBe(true);
      }
      // admin is implicit in `authorize-platform.ts`. Listing it here would be
      // a second, drift-prone source of truth for the same grant.
      expect(rule.roles, `${key} lists admin explicitly`).not.toContain("admin");
    }
  });

  it("gives every rule a non-empty operation phrase for the refusal message", () => {
    for (const [key, rule] of Object.entries(PLATFORM_PERMISSIONS)) {
      expect(rule.operation.length, `${key} has no operation phrase`).toBeGreaterThan(0);
    }
  });

  it("uses only ownable record types the shared kernel knows about", () => {
    for (const [key, rule] of Object.entries(PLATFORM_PERMISSIONS)) {
      if (rule.ownable === undefined) continue;
      expect(OWNABLE_RECORD_TYPES, `${key} uses unknown record type`).toContain(rule.ownable.recordType);
    }
  });

  it("never grants a role that does not exist to anything", () => {
    const granted = new Set(Object.values(PLATFORM_PERMISSIONS).flatMap((rule) => [...rule.roles]));
    for (const role of granted) {
      expect(USER_ROLES).toContain(role);
    }
  });
});

describe("the beneficiary registry policy", () => {
  const beneficiaryKeys = Object.keys(PLATFORM_PERMISSIONS).filter((key) => key.startsWith("beneficiaryRegistry."));

  it("covers all five beneficiary members", () => {
    expect(beneficiaryKeys).toHaveLength(5);
  });

  it("admits district_officer and ngo_coordinator only", () => {
    for (const key of beneficiaryKeys) {
      expect([...PLATFORM_PERMISSIONS[key]!.roles].sort(), key).toEqual(["district_officer", "ngo_coordinator"]);
    }
  });

  it("has no ownership widening anywhere in it", () => {
    // Ownership widens rights (ADR 0009). Applied here it would hand a citizen a
    // route back into a registry of widows' and orphans' names, which is the
    // exact hole this policy closes.
    for (const key of beneficiaryKeys) {
      expect(PLATFORM_PERMISSIONS[key]!.ownable, `${key} is ownable`).toBeUndefined();
    }
  });
});

describe("ownership widening is actually reachable", () => {
  /**
   * The bug this catches shipped once and was caught in review, which is why it
   * is a test rather than a comment.
   *
   * `authorizePlatform` consults ownership ONLY after the role grant has failed.
   * So a rule that both lists every role AND declares `ownable` has a dead
   * clause: it reads as "your own record" and enforces "anybody's". The original
   * `volunteerManagement.setAvailability` was written that way, which let any
   * citizen flip any volunteer's availability while looking, in the table, like
   * self-service.
   *
   * A rule is either scoped by role — in which case ownership can widen it — or
   * open to everyone, in which case it must not claim to be ownable.
   */
  it("never declares an ownable clause on a rule already granted to every role", () => {
    for (const [key, rule] of Object.entries(PLATFORM_PERMISSIONS)) {
      if (rule.ownable === undefined) continue;
      const grantsEveryone = USER_ROLES.filter((role) => role !== "admin").every((role) =>
        (rule.roles as readonly string[]).includes(role),
      );
      expect(grantsEveryone, `${key} is ownable but already grants every role, so ownership is dead`).toBe(
        false,
      );
    }
  });
});

describe("recordIdFrom extractors", () => {
  const ownableRules = Object.entries(PLATFORM_PERMISSIONS).filter(([, rule]) => rule.ownable !== undefined);

  it("exist on the seven members the matrix marks ownable", () => {
    expect(ownableRules.map(([key]) => key).sort()).toEqual([
      "developmentPlanning.addGoal",
      "developmentPlanning.addMilestone",
      "developmentPlanning.completeMilestone",
      "issueTracking.resolveIssue",
      "issueTracking.startProgress",
      "villageRegistry.correctVillageProfile",
      "volunteerManagement.setAvailability",
    ]);
  });

  it("pull the id out of a realistic input", () => {
    const cases: Record<string, unknown> = {
      "villageRegistry.correctVillageProfile": { villageId: "v-1", reason: "typo" },
      "issueTracking.startProgress": { issueId: "i-1" },
      "issueTracking.resolveIssue": { issueId: "i-2", resolutionNote: "fixed" },
      "volunteerManagement.setAvailability": { volunteerId: "vol-1", availability: "available" },
      "developmentPlanning.addGoal": { planId: "p-1", area: "water", description: "well" },
      "developmentPlanning.addMilestone": { planId: "p-2", goalId: "g-1", title: "t", targetDate: "2026-01-01" },
      "developmentPlanning.completeMilestone": { planId: "p-3", goalId: "g-1", milestoneId: "m-1" },
    };
    const expected: Record<string, string> = {
      "villageRegistry.correctVillageProfile": "v-1",
      "issueTracking.startProgress": "i-1",
      "issueTracking.resolveIssue": "i-2",
      "volunteerManagement.setAvailability": "vol-1",
      "developmentPlanning.addGoal": "p-1",
      "developmentPlanning.addMilestone": "p-2",
      "developmentPlanning.completeMilestone": "p-3",
    };
    for (const [key, rule] of ownableRules) {
      expect(rule.ownable!.recordIdFrom(cases[key]), key).toBe(expected[key]);
    }
  });

  it("return null rather than throwing on junk input", () => {
    // A malformed input is the use case's to report as a 400. An authorization
    // layer that threw on it would turn that into a 500.
    for (const [key, rule] of ownableRules) {
      const from = rule.ownable!.recordIdFrom;
      expect(from(undefined), key).toBeNull();
      expect(from(null), key).toBeNull();
      expect(from("a string"), key).toBeNull();
      expect(from({}), key).toBeNull();
      expect(from({ wrongField: "x" }), key).toBeNull();
    }
  });
});
