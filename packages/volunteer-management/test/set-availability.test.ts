import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, unwrap, volunteerId } from "@afrip/shared-kernel";
import { Volunteer } from "../src/domain/volunteer.js";
import { SetAvailability, type SetAvailabilityInput } from "../src/application/set-availability.js";
import type { VolunteerRepository } from "../src/application/ports.js";

function buildRepository(volunteer: Volunteer | null = null, overrides: Partial<VolunteerRepository> = {}): VolunteerRepository {
  return {
    findById: vi.fn().mockResolvedValue(volunteer),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("SetAvailability", () => {
  it("updates volunteer availability and publishes event", async () => {
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
    const useCase = new SetAvailability({ repository, clock, eventPublisher });

    const input: SetAvailabilityInput = {
      volunteerId: volunteer.id,
      availability: "unavailable",
    };
    const result = await useCase.execute(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousAvailability).toBe("available");

    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = (repository.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(saved.availability).toBe("unavailable");
  });

  it("publishes volunteer.availability-changed.v1 event", async () => {
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
    const useCase = new SetAvailability({ repository, clock, eventPublisher });

    await useCase.execute({
      volunteerId: volunteer.id,
      availability: "unavailable",
    });

    expect(eventPublisher.eventNames()).toEqual(["volunteer.availability-changed.v1"]);
    expect(eventPublisher.published[0]).toMatchObject({
      name: "volunteer.availability-changed.v1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        volunteerId: "vol-1",
        availability: "unavailable",
        previousAvailability: "available",
      },
    });
  });

  it("returns error if volunteer not found", async () => {
    const repository = buildRepository(null);
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new SetAvailability({ repository, clock, eventPublisher });

    const result = await useCase.execute({
      volunteerId: unwrap(volunteerId("vol-999")),
      availability: "unavailable",
    });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });
});
