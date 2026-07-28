import { describe, expect, it } from "vitest";
import { isErr, isOk, unwrap, type AssignmentId, type NgoId, type VillageId } from "@afrip/shared-kernel";
import { VillageAssignment } from "../src/domain/village-assignment.js";

function makeAssignment(): VillageAssignment {
  return VillageAssignment.create({
    id: "asn-1" as AssignmentId,
    villageId: "village-1" as VillageId,
    ngoId: "ngo-1" as NgoId,
    assignedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("VillageAssignment aggregate", () => {
  it("starts active with an empty committee", () => {
    const assignment = makeAssignment();
    expect(assignment.status).toBe("active");
    expect(assignment.committee).toEqual([]);
  });

  it("adds committee members with unique roles", () => {
    const assignment = makeAssignment();

    expect(isOk(assignment.addCommitteeMember({ role: "leader", name: "Asha" }))).toBe(true);
    expect(
      isOk(assignment.addCommitteeMember({ role: "engineer", name: "Priya", contact: "p@example.org" })),
    ).toBe(true);

    expect(assignment.committee).toEqual([
      { role: "leader", name: "Asha" },
      { role: "engineer", name: "Priya", contact: "p@example.org" },
    ]);
  });

  it("rejects a duplicate role on the same assignment", () => {
    const assignment = makeAssignment();
    unwrap(assignment.addCommitteeMember({ role: "leader", name: "Asha" }));

    const result = assignment.addCommitteeMember({ role: "leader", name: "Rohan" });

    expect(isErr(result)).toBe(true);
    expect(assignment.committee).toHaveLength(1);
  });

  it("retires an active assignment", () => {
    const assignment = makeAssignment();

    const result = assignment.retire();

    expect(isOk(result)).toBe(true);
    expect(assignment.status).toBe("retired");
  });

  it("errs retiring an already-retired assignment", () => {
    const assignment = makeAssignment();
    unwrap(assignment.retire());

    const result = assignment.retire();

    expect(isErr(result)).toBe(true);
  });

  it("rejects adding committee members to a retired assignment", () => {
    const assignment = makeAssignment();
    unwrap(assignment.retire());

    const result = assignment.addCommitteeMember({ role: "leader", name: "Asha" });

    expect(isErr(result)).toBe(true);
    expect(assignment.committee).toHaveLength(0);
  });

  it("does not let external code mutate the aggregate's internal state via the returned committee array", () => {
    const assignment = makeAssignment();
    unwrap(assignment.addCommitteeMember({ role: "leader", name: "Asha" }));

    const committee = assignment.committee as unknown as Array<unknown>;
    committee.push({ role: "volunteer", name: "Hacker" });

    expect(assignment.committee).toHaveLength(1);
  });
});
