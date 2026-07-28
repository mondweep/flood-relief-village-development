import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, unwrap, villageId, volunteerId } from "@afrip/shared-kernel";
import { Volunteer } from "../src/domain/volunteer.js";
import { LogHours, type LogHoursInput } from "../src/application/log-hours.js";
import type { VolunteerRepository } from "../src/application/ports.js";

function buildRepository(volunteer: Volunteer | null = null, overrides: Partial<VolunteerRepository> = {}): VolunteerRepository {
  return {
    findById: vi.fn().mockResolvedValue(volunteer),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("LogHours", () => {
  it("logs hours against an assignment and publishes event", async () => {
    const volunteer = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    }));

    // Add an assignment manually
    const assignment = {
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "house repair",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 0,
    };
    volunteer.assignTo(assignment);

    const repository = buildRepository(volunteer);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new LogHours({ repository, clock, eventPublisher });

    const input: LogHoursInput = {
      volunteerId: volunteer.id,
      assignmentId: "assign-1",
      hours: 8,
    };
    const result = await useCase.execute(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hoursLogged).toBe(8);

    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = (repository.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(saved.assignments[0].hours).toBe(8);
  });

  it("publishes volunteer.hours-logged.v1 event", async () => {
    const volunteer = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    }));

    const assignment = {
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "house repair",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 0,
    };
    volunteer.assignTo(assignment);

    const repository = buildRepository(volunteer);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new LogHours({ repository, clock, eventPublisher });

    await useCase.execute({
      volunteerId: volunteer.id,
      assignmentId: "assign-1",
      hours: 8,
    });

    expect(eventPublisher.eventNames()).toEqual(["volunteer.hours-logged.v1"]);
    expect(eventPublisher.published[0]).toMatchObject({
      name: "volunteer.hours-logged.v1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        volunteerId: "vol-1",
        assignmentId: "assign-1",
        hours: 8,
      },
    });
  });

  it("returns error if volunteer not found", async () => {
    const repository = buildRepository(null);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new LogHours({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      volunteerId: unwrap(volunteerId("vol-999")),
      assignmentId: "assign-1",
      hours: 8,
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns error if hours <= 0", async () => {
    const volunteer = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    }));

    const assignment = {
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "house repair",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 0,
    };
    volunteer.assignTo(assignment);

    const repository = buildRepository(volunteer);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new LogHours({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      volunteerId: volunteer.id,
      assignmentId: "assign-1",
      hours: 0,
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("returns error if assignment not found", async () => {
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
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new LogHours({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      volunteerId: volunteer.id,
      assignmentId: "unknown-assign",
      hours: 8,
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });
});
