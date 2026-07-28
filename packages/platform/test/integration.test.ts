import { describe, expect, it } from "vitest";
import { FixedClock, type DomainEvent, type Result } from "@afrip/shared-kernel";
import { createPlatform, type Platform } from "@afrip/platform";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

function makePlatform(): { platform: Platform; clock: FixedClock } {
  const clock = new FixedClock(new Date("2026-07-01T00:00:00.000Z"));
  return { platform: createPlatform({ clock }), clock };
}

async function registerVillage(platform: Platform): Promise<string> {
  const result = await platform.villageRegistry.registerVillage.execute({
    name: "Rampur",
    district: "Darbhanga",
    state: "Bihar",
    geo: { lat: 26.15, lng: 85.9 },
    population: 1200,
    households: 260,
    affectedFamilies: 190,
    severity: "severe",
  });
  return unwrap(result).villageId;
}

async function registerNgo(platform: Platform, name: string): Promise<string> {
  const result = await platform.ngoCoordination.registerNgo.execute({
    name,
    focusAreas: ["infrastructure", "water"],
    capacity: 3,
  });
  return unwrap(result).ngoId;
}

describe("platform composition root (end-to-end over in-memory adapters)", () => {
  it("retires NGO A's assignment when NGO B is assigned to the same village", async () => {
    const { platform } = makePlatform();
    const retired: DomainEvent[] = [];
    const assigned: DomainEvent[] = [];
    platform.bus.subscribe("assignment.retired.v1", async (event) => {
      retired.push(event);
    });
    platform.bus.subscribe("ngo.assigned-to-village.v1", async (event) => {
      assigned.push(event);
    });

    const villageId = await registerVillage(platform);
    const ngoA = await registerNgo(platform, "Relief Works A");
    const ngoB = await registerNgo(platform, "Relief Works B");

    const assignmentA = unwrap(
      await platform.ngoCoordination.assignNgoToVillage.execute({ villageId, ngoId: ngoA }),
    ).assignmentId;
    const assignmentB = unwrap(
      await platform.ngoCoordination.assignNgoToVillage.execute({ villageId, ngoId: ngoB }),
    ).assignmentId;

    // A's assignment was retired when B took over.
    expect(retired).toHaveLength(1);
    expect(retired[0]?.payload).toMatchObject({ assignmentId: assignmentA, villageId, ngoId: ngoA });
    expect(assigned.map((e) => e.payload)).toMatchObject([
      { assignmentId: assignmentA, ngoId: ngoA },
      { assignmentId: assignmentB, ngoId: ngoB },
    ]);

    // State-based check that B is now the single active assignment: an
    // NGO-routable issue routes to B as the village's lead NGO.
    const issueId = unwrap(
      await platform.issueTracking.reportIssue.execute({
        villageId,
        category: "infrastructure",
        description: "Bridge approach road washed out",
        photoRefs: [],
        gps: { lat: 26.15, lng: 85.9 },
      }),
    ).issueId;
    const routing = unwrap(await platform.issueTracking.routeIssue.execute({ issueId }));
    expect(routing).toEqual({ issueId, partyType: "lead_ngo", party: ngoB });
  });

  it("recalculates the recovery index when a damage assessment is recorded (via the bus)", async () => {
    const { platform } = makePlatform();
    const villageId = await registerVillage(platform);

    // No recovery index exists before the assessment.
    const before = await platform.recoveryIntelligence.getRecoveryIndex.execute({ villageId });
    expect(before.ok).toBe(false);

    unwrap(
      await platform.villageRegistry.recordDamageAssessment.execute({
        villageId,
        assessment: {
          housesDamaged: 45,
          schoolsDamaged: 1,
          healthCentresDamaged: 1,
          waterSourcesDamaged: 3,
          agricultureHectaresLost: 120,
          livestockLost: 60,
        },
      }),
    );

    // The bus-subscribed handler triggered UpsertDimensionScores for the village.
    const index = unwrap(await platform.recoveryIntelligence.getRecoveryIndex.execute({ villageId }));
    expect(index.villageId).toBe(villageId);
    expect(index.calculatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(index.composite).toBe(0);

    const history = unwrap(await platform.recoveryIntelligence.getScoreHistory.execute({ villageId }));
    expect(history.history).toHaveLength(1);
  });

  it("publishes a duplicate-aid-flagged event when two providers deliver the same aid type in the window", async () => {
    const { platform, clock } = makePlatform();
    const flagged: DomainEvent[] = [];
    platform.bus.subscribe("beneficiary.duplicate-aid-flagged.v1", async (event) => {
      flagged.push(event);
    });

    const villageId = await registerVillage(platform);
    const beneficiaryId = unwrap(
      await platform.beneficiaryRegistry.registerBeneficiary.execute({
        villageId,
        name: "Sunita Devi",
        category: "widow",
      }),
    ).beneficiaryId;

    const first = unwrap(
      await platform.beneficiaryRegistry.recordAid.execute({
        beneficiaryId,
        aidType: "food",
        providerId: "provider-ngo-1",
        providerType: "ngo",
      }),
    );
    expect(first.duplicate).toBe(false);
    expect(flagged).toHaveLength(0);

    clock.advanceDays(5); // still inside the 14-day duplicate window

    const second = unwrap(
      await platform.beneficiaryRegistry.recordAid.execute({
        beneficiaryId,
        aidType: "food",
        providerId: "provider-gov-1",
        providerType: "government",
      }),
    );
    expect(second.duplicate).toBe(true);

    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.payload).toMatchObject({
      beneficiaryId,
      aidType: "food",
      providerIds: ["provider-ngo-1", "provider-gov-1"],
    });
  });

  it("routes an infrastructure issue to the village's active lead NGO", async () => {
    const { platform } = makePlatform();
    const villageId = await registerVillage(platform);
    const ngoId = await registerNgo(platform, "Bihar Rebuild Trust");
    unwrap(await platform.ngoCoordination.assignNgoToVillage.execute({ villageId, ngoId }));

    const issueId = unwrap(
      await platform.issueTracking.reportIssue.execute({
        villageId,
        category: "infrastructure",
        description: "Hand pump platform collapsed",
        photoRefs: ["photo-1"],
        gps: { lat: 26.16, lng: 85.91 },
      }),
    ).issueId;

    const routing = unwrap(await platform.issueTracking.routeIssue.execute({ issueId }));
    expect(routing.partyType).toBe("lead_ngo");
    expect(routing.party).toBe(ngoId);
  });
});
