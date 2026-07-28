import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapturingEventPublisher,
  FixedClock,
  isErr,
  isOk,
  unwrap,
  type AssignmentId,
  type NgoId,
  type VillageId,
} from "@afrip/shared-kernel";
import { AddCommitteeMember } from "../src/application/add-committee-member.js";
import { VillageAssignment } from "../src/domain/village-assignment.js";
import type { AssignmentRepository } from "../src/application/ports.js";

function makeAssignment(): VillageAssignment {
  return VillageAssignment.create({
    id: "asn-1" as AssignmentId,
    villageId: "village-1" as VillageId,
    ngoId: "ngo-1" as NgoId,
    assignedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("AddCommitteeMember use case", () => {
  let assignmentRepository: AssignmentRepository;
  let clock: FixedClock;
  let eventPublisher: CapturingEventPublisher;
  let useCase: AddCommitteeMember;

  beforeEach(() => {
    assignmentRepository = {
      findActiveByVillage: vi.fn().mockResolvedValue(undefined),
      findActiveByNgo: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    clock = new FixedClock(new Date("2026-03-01T00:00:00.000Z"));
    eventPublisher = new CapturingEventPublisher();
    useCase = new AddCommitteeMember({ assignmentRepository, eventPublisher, clock });
  });

  it("errs when the village has no active assignment", async () => {
    (assignmentRepository.findActiveByVillage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await useCase.execute({ villageId: "village-1", role: "leader", name: "Asha" });

    expect(isErr(result)).toBe(true);
    expect(assignmentRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("errs when the role is already filled on the active assignment", async () => {
    const assignment = makeAssignment();
    unwrap(assignment.addCommitteeMember({ role: "leader", name: "Asha" }));
    (assignmentRepository.findActiveByVillage as ReturnType<typeof vi.fn>).mockResolvedValue(assignment);

    const result = await useCase.execute({ villageId: "village-1", role: "leader", name: "Rohan" });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toMatch(/already filled/i);
    expect(assignmentRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("adds a committee member, saves the assignment and publishes committee-member.added.v1", async () => {
    const assignment = makeAssignment();
    (assignmentRepository.findActiveByVillage as ReturnType<typeof vi.fn>).mockResolvedValue(assignment);

    const result = await useCase.execute({
      villageId: "village-1",
      role: "engineer",
      name: "Priya",
      contact: "priya@example.org",
    });

    expect(isOk(result)).toBe(true);
    expect(unwrap(result).assignmentId).toBe("asn-1");
    expect(assignment.committee).toEqual([{ role: "engineer", name: "Priya", contact: "priya@example.org" }]);

    expect(assignmentRepository.save).toHaveBeenCalledWith(assignment);
    expect(eventPublisher.eventNames()).toEqual(["committee-member.added.v1"]);
    const published = eventPublisher.published[0]!;
    expect(published.payload).toEqual({ assignmentId: "asn-1", role: "engineer" });
    expect(published.occurredAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("errs on a malformed villageId without touching the repository", async () => {
    const result = await useCase.execute({ villageId: "", role: "leader", name: "Asha" });

    expect(isErr(result)).toBe(true);
    expect(assignmentRepository.findActiveByVillage).not.toHaveBeenCalled();
    expect(assignmentRepository.save).not.toHaveBeenCalled();
  });
});
