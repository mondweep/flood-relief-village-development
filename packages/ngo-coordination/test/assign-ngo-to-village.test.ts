import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapturingEventPublisher,
  FixedClock,
  SequentialIdGenerator,
  isErr,
  isOk,
  unwrap,
  type AssignmentId,
  type NgoId,
  type VillageId,
} from "@afrip/shared-kernel";
import { AssignNgoToVillage } from "../src/application/assign-ngo-to-village.js";
import { Ngo } from "../src/domain/ngo.js";
import { VillageAssignment } from "../src/domain/village-assignment.js";
import type { AssignmentRepository, NgoRepository } from "../src/application/ports.js";

function makeNgo(id: string, capacity: number): Ngo {
  return unwrap(Ngo.create({ id: id as NgoId, name: "Test NGO", focusAreas: ["water"], capacity }));
}

describe("AssignNgoToVillage use case", () => {
  let ngoRepository: NgoRepository;
  let assignmentRepository: AssignmentRepository;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;
  let eventPublisher: CapturingEventPublisher;
  let useCase: AssignNgoToVillage;

  beforeEach(() => {
    ngoRepository = {
      findById: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    };
    assignmentRepository = {
      findActiveByVillage: vi.fn().mockResolvedValue(undefined),
      findActiveByNgo: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue(undefined),
    };
    clock = new FixedClock(new Date("2026-02-01T00:00:00.000Z"));
    idGenerator = new SequentialIdGenerator("asn");
    eventPublisher = new CapturingEventPublisher();
    useCase = new AssignNgoToVillage({ ngoRepository, assignmentRepository, idGenerator, clock, eventPublisher });
  });

  it("errs when the NGO is unknown, touching neither the assignment repository nor the publisher", async () => {
    (ngoRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await useCase.execute({ villageId: "village-1", ngoId: "ngo-1" });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toMatch(/ngo/i);
    expect(assignmentRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("errs with 'capacity exceeded' when the NGO's active assignments reach its capacity", async () => {
    const ngo = makeNgo("ngo-1", 1);
    (ngoRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ngo);
    const existing = VillageAssignment.create({
      id: "asn-existing" as AssignmentId,
      villageId: "village-2" as VillageId,
      ngoId: "ngo-1" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    (assignmentRepository.findActiveByNgo as ReturnType<typeof vi.fn>).mockResolvedValue([existing]);

    const result = await useCase.execute({ villageId: "village-1", ngoId: "ngo-1" });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toMatch(/capacity exceeded/i);
    expect(assignmentRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("assigns the NGO to an unassigned village and publishes ngo.assigned-to-village.v1", async () => {
    const ngo = makeNgo("ngo-1", 3);
    (ngoRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ngo);

    const result = await useCase.execute({ villageId: "village-1", ngoId: "ngo-1" });

    expect(isOk(result)).toBe(true);
    expect(unwrap(result).assignmentId).toBe("asn-1");

    expect(assignmentRepository.save).toHaveBeenCalledTimes(1);
    const saved = (assignmentRepository.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as VillageAssignment;
    expect(saved.id).toBe("asn-1");
    expect(saved.villageId).toBe("village-1");
    expect(saved.ngoId).toBe("ngo-1");
    expect(saved.status).toBe("active");
    expect(saved.assignedAt).toBe("2026-02-01T00:00:00.000Z");

    expect(eventPublisher.eventNames()).toEqual(["ngo.assigned-to-village.v1"]);
    const published = eventPublisher.published[0]!;
    expect(published.payload).toEqual({
      assignmentId: "asn-1",
      villageId: "village-1",
      ngoId: "ngo-1",
    });
    expect(published.occurredAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("retires the previous active assignment (never deletes it) before creating the new one", async () => {
    const ngo = makeNgo("ngo-2", 5);
    (ngoRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ngo);
    const previous = VillageAssignment.create({
      id: "asn-old" as AssignmentId,
      villageId: "village-1" as VillageId,
      ngoId: "ngo-old" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    (assignmentRepository.findActiveByVillage as ReturnType<typeof vi.fn>).mockResolvedValue(previous);

    const result = await useCase.execute({ villageId: "village-1", ngoId: "ngo-2" });

    expect(isOk(result)).toBe(true);
    expect(previous.status).toBe("retired");

    expect(assignmentRepository.save).toHaveBeenCalledTimes(2);
    const [firstSaveArg] = (assignmentRepository.save as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(firstSaveArg).toBe(previous);
    expect(firstSaveArg.status).toBe("retired");
    const [secondSaveArg] = (assignmentRepository.save as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(secondSaveArg.status).toBe("active");
    expect(secondSaveArg.ngoId).toBe("ngo-2");

    expect(eventPublisher.eventNames()).toEqual(["assignment.retired.v1", "ngo.assigned-to-village.v1"]);
    expect(eventPublisher.published[0]!.payload).toEqual({
      assignmentId: "asn-old",
      villageId: "village-1",
      ngoId: "ngo-old",
    });
    expect(eventPublisher.published[1]!.payload).toMatchObject({
      villageId: "village-1",
      ngoId: "ngo-2",
    });
  });

  it("errs on a malformed villageId or ngoId without touching either repository", async () => {
    const result = await useCase.execute({ villageId: "", ngoId: "" });

    expect(isErr(result)).toBe(true);
    expect(ngoRepository.findById).not.toHaveBeenCalled();
    expect(assignmentRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("leaves the previous assignment untouched when the new AssignmentId is invalid", async () => {
    const ngo = makeNgo("ngo-2", 5);
    (ngoRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ngo);
    const previous = VillageAssignment.create({
      id: "asn-old" as AssignmentId,
      villageId: "village-1" as VillageId,
      ngoId: "ngo-old" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    (assignmentRepository.findActiveByVillage as ReturnType<typeof vi.fn>).mockResolvedValue(previous);
    vi.spyOn(idGenerator, "next").mockReturnValue("   ");

    const result = await useCase.execute({ villageId: "village-1", ngoId: "ngo-2" });

    expect(isErr(result)).toBe(true);
    expect(previous.status).toBe("active");
    expect(assignmentRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("allows re-assigning the same NGO to the village it already leads, even at capacity 1", async () => {
    const ngo = makeNgo("ngo-1", 1);
    (ngoRepository.findById as ReturnType<typeof vi.fn>).mockResolvedValue(ngo);
    const incumbent = VillageAssignment.create({
      id: "asn-old" as AssignmentId,
      villageId: "village-1" as VillageId,
      ngoId: "ngo-1" as NgoId,
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
    (assignmentRepository.findActiveByVillage as ReturnType<typeof vi.fn>).mockResolvedValue(incumbent);
    (assignmentRepository.findActiveByNgo as ReturnType<typeof vi.fn>).mockResolvedValue([incumbent]);

    const result = await useCase.execute({ villageId: "village-1", ngoId: "ngo-1" });

    expect(isOk(result)).toBe(true);
    expect(incumbent.status).toBe("retired");

    expect(assignmentRepository.save).toHaveBeenCalledTimes(2);
    const [firstSaveArg] = (assignmentRepository.save as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(firstSaveArg).toBe(incumbent);
    expect(firstSaveArg.status).toBe("retired");
    const [secondSaveArg] = (assignmentRepository.save as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(secondSaveArg.status).toBe("active");
    expect(secondSaveArg.villageId).toBe("village-1");
    expect(secondSaveArg.ngoId).toBe("ngo-1");

    expect(eventPublisher.eventNames()).toEqual(["assignment.retired.v1", "ngo.assigned-to-village.v1"]);
  });
});
