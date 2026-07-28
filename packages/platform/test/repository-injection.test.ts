import { describe, expect, it } from "vitest";
import { FixedClock, type Result } from "@afrip/shared-kernel";
import { createPlatform, type PlatformRepositories } from "@afrip/platform";
import type { Village, VillageRepository } from "@afrip/village-registry";
import type { Ngo, NgoRepository } from "@afrip/ngo-coordination";
import type { AssignmentRepository, VillageAssignment } from "@afrip/ngo-coordination";
import type { RecoveryIndex, RecoveryIndexRepository } from "@afrip/recovery-intelligence";
import type { Issue, IssueRepository } from "@afrip/issue-tracking";
import type { Beneficiary, BeneficiaryRepository } from "@afrip/beneficiary-registry";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

/** Records which port methods the composition root actually calls. */
interface Spy {
  readonly calls: string[];
}

function spy(): Spy & {
  village: VillageRepository;
  ngo: NgoRepository;
  assignment: AssignmentRepository;
  recoveryIndex: RecoveryIndexRepository;
  issue: IssueRepository;
  beneficiary: BeneficiaryRepository;
} {
  const calls: string[] = [];
  const note = (name: string): void => {
    calls.push(name);
  };

  return {
    calls,
    village: {
      findById: async () => (note("village.findById"), null),
      save: async (_village: Village) => note("village.save"),
      listAll: async () => (note("village.listAll"), []),
    },
    ngo: {
      findById: async () => (note("ngo.findById"), undefined),
      save: async (_ngo: Ngo) => note("ngo.save"),
    },
    assignment: {
      findActiveByVillage: async () => (note("assignment.findActiveByVillage"), undefined),
      findActiveByNgo: async () => (note("assignment.findActiveByNgo"), []),
      save: async (_assignment: VillageAssignment) => note("assignment.save"),
    },
    recoveryIndex: {
      findByVillage: async () => (note("recoveryIndex.findByVillage"), null),
      save: async (_index: RecoveryIndex) => note("recoveryIndex.save"),
    },
    issue: {
      findById: async () => (note("issue.findById"), null),
      save: async (_issue: Issue) => note("issue.save"),
      listByVillage: async () => (note("issue.listByVillage"), []),
      listByStatus: async () => (note("issue.listByStatus"), []),
    },
    beneficiary: {
      findById: async () => (note("beneficiary.findById"), null),
      save: async (_beneficiary: Beneficiary) => note("beneficiary.save"),
      listByVillage: async () => (note("beneficiary.listByVillage"), []),
      listAll: async () => (note("beneficiary.listAll"), []),
    },
  };
}

const clock = (): FixedClock => new FixedClock(new Date("2026-07-01T00:00:00.000Z"));

function platformWith(repositories: PlatformRepositories) {
  return createPlatform({ clock: clock(), repositories });
}

const VILLAGE_INPUT = {
  name: "Rampur",
  district: "Darbhanga",
  state: "Bihar",
  geo: { lat: 26.15, lng: 85.9 },
  population: 1200,
  households: 260,
  affectedFamilies: 190,
  severity: "severe" as const,
};

describe("createPlatform — repository injection", () => {
  it("writes villages through the injected repository", async () => {
    const repos = spy();
    const platform = platformWith({ village: repos.village });

    unwrap(await platform.villageRegistry.registerVillage.execute(VILLAGE_INPUT));

    expect(repos.calls).toContain("village.save");
  });

  it("reads villages through the injected repository, so the in-memory map is bypassed", async () => {
    const repos = spy();
    const platform = platformWith({ village: repos.village });

    // Registered, then immediately read back: with the default in-memory adapter
    // this succeeds. Against a repository that stores nothing it must not — which
    // is only true if the injected repository is the one actually being used.
    const registered = unwrap(await platform.villageRegistry.registerVillage.execute(VILLAGE_INPUT));
    const profile = await platform.villageRegistry.getVillageProfile.execute({
      villageId: registered.villageId,
    });

    expect(profile.ok).toBe(false);
    expect(repos.calls).toEqual(["village.save", "village.findById"]);
  });

  it("writes NGOs through the injected repository", async () => {
    const repos = spy();
    const platform = platformWith({ ngo: repos.ngo });

    unwrap(
      await platform.ngoCoordination.registerNgo.execute({
        name: "Sewa Trust",
        focusAreas: ["water"],
        capacity: 3,
      }),
    );

    expect(repos.calls).toContain("ngo.save");
  });

  it("queries assignments through the injected repository", async () => {
    const repos = spy();
    const platform = platformWith({ assignment: repos.assignment });

    const unassigned = unwrap(
      await platform.ngoCoordination.listUnassignedVillages.execute([
        { villageId: "village-1", severity: "critical" },
      ]),
    );

    expect(repos.calls).toEqual(["assignment.findActiveByVillage"]);
    expect(unassigned).toEqual([{ villageId: "village-1", severity: "critical" }]);
  });

  it("reads recovery indices through the injected repository", async () => {
    const repos = spy();
    const platform = platformWith({ recoveryIndex: repos.recoveryIndex });

    await platform.recoveryIntelligence.getRecoveryIndex.execute({ villageId: "village-1" });

    expect(repos.calls).toContain("recoveryIndex.findByVillage");
  });

  it("writes issues through the injected repository", async () => {
    const repos = spy();
    const platform = platformWith({ issue: repos.issue });

    unwrap(
      await platform.issueTracking.reportIssue.execute({
        villageId: "village-1",
        category: "water",
        description: "Handpump collapsed",
        photoRefs: [],
        gps: { lat: 25.6, lng: 85.1 },
      }),
    );

    expect(repos.calls).toContain("issue.save");
  });

  it("writes beneficiaries through the injected repository", async () => {
    const repos = spy();
    const platform = platformWith({ beneficiary: repos.beneficiary });

    unwrap(
      await platform.beneficiaryRegistry.registerBeneficiary.execute({
        villageId: "village-1",
        name: "Sunita Devi",
        category: "widow",
      }),
    );

    expect(repos.calls).toContain("beneficiary.save");
  });

  it("routes issues against the injected assignment and NGO repositories", async () => {
    const repos = spy();
    const platform = platformWith({
      issue: repos.issue,
      assignment: repos.assignment,
      ngo: repos.ngo,
    });

    await platform.issueTracking.routeIssue.execute({ issueId: "issue-1" });

    // The composition-root AssignmentLookup adapter must be built over the
    // INJECTED repositories, not over freshly constructed in-memory ones.
    expect(repos.calls).toContain("issue.findById");
  });

  it("leaves every un-injected context on its in-memory default", async () => {
    const repos = spy();
    const platform = platformWith({ village: repos.village });

    const ngo = unwrap(
      await platform.ngoCoordination.registerNgo.execute({
        name: "Sewa Trust",
        focusAreas: ["water"],
        capacity: 3,
      }),
    );

    expect(ngo.ngoId).toBeTruthy();
    expect(repos.calls.filter((call) => call.startsWith("ngo."))).toEqual([]);
  });

  it("still defaults to a fully in-memory platform when nothing is injected", async () => {
    const platform = createPlatform({ clock: clock() });

    const registered = unwrap(await platform.villageRegistry.registerVillage.execute(VILLAGE_INPUT));
    const profile = await platform.villageRegistry.getVillageProfile.execute({
      villageId: registered.villageId,
    });

    expect(profile.ok).toBe(true);
  });
});
