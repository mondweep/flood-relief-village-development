import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, SequentialIdGenerator, isErr, unwrap, villageId, volunteerId } from "@afrip/shared-kernel";
import { Volunteer } from "../src/domain/volunteer.js";
import { AssignVolunteer, type AssignVolunteerInput } from "../src/application/assign-volunteer.js";
import type { VolunteerRepository } from "../src/application/ports.js";

function buildRepository(volunteer: Volunteer | null = null, overrides: Partial<VolunteerRepository> = {}): VolunteerRepository {
  return {
    findById: vi.fn().mockResolvedValue(volunteer),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("AssignVolunteer", () => {
  it("assigns volunteer to village and publishes event", async () => {
    const volunteer = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    }));

    const repository = buildRepository(volunteer);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("assign");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AssignVolunteer({ repository, clock, idGenerator, eventPublisher });

    const input: AssignVolunteerInput = {
      volunteerId: volunteer.id,
      villageId: unwrap(villageId("village-1")),
      task: "house repair",
    };
    const result = await useCase.execute(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assignmentId).toBe("assign-1");
    expect(result.value.volunteerId).toBe("vol-1");

    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = (repository.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(saved.assignments).toHaveLength(1);
    expect(saved.assignments[0]).toMatchObject({
      id: "assign-1",
      villageId: "village-1",
      task: "house repair",
    });
  });

  it("publishes volunteer.assigned.v1 event", async () => {
    const volunteer = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    }));

    const repository = buildRepository(volunteer);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("assign");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AssignVolunteer({ repository, clock, idGenerator, eventPublisher });

    await useCase.execute({
      volunteerId: volunteer.id,
      villageId: unwrap(villageId("village-1")),
      task: "house repair",
    });

    expect(eventPublisher.eventNames()).toEqual(["volunteer.assigned.v1"]);
    expect(eventPublisher.published[0]).toMatchObject({
      name: "volunteer.assigned.v1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        volunteerId: "vol-1",
        villageId: "village-1",
        task: "house repair",
        assignmentId: "assign-1",
      },
    });
  });

  it("returns error if volunteer not found", async () => {
    const repository = buildRepository(null);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("assign");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AssignVolunteer({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute({
      volunteerId: unwrap(volunteerId("vol-999")),
      villageId: unwrap(villageId("village-1")),
      task: "house repair",
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns error if volunteer is not available", async () => {
    const volunteer = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "unavailable",
    }));

    const repository = buildRepository(volunteer);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("assign");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new AssignVolunteer({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute({
      volunteerId: volunteer.id,
      villageId: unwrap(villageId("village-1")),
      task: "house repair",
    });

    expect(result.ok).toBe(false);
    expect(isErr(result) ? result.error : undefined).toBe("volunteer is not available");
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });
});
