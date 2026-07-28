import { describe, expect, it, vi } from "vitest";
import { CapturingEventPublisher, FixedClock, SequentialIdGenerator, unwrap, volunteerId } from "@afrip/shared-kernel";
import { RegisterVolunteer, type RegisterVolunteerInput } from "../src/application/register-volunteer.js";
import type { VolunteerRepository } from "../src/application/ports.js";

function buildRepository(overrides: Partial<VolunteerRepository> = {}): VolunteerRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function validInput(): RegisterVolunteerInput {
  return {
    name: "Alice Johnson",
    skills: ["carpentry", "plumbing"],
    languages: ["English", "Hindi"],
    location: "Patna",
  };
}

describe("RegisterVolunteer", () => {
  it("saves the new volunteer and returns its generated id", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("vol");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RegisterVolunteer({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute(validInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.volunteerId).toBe("vol-1");

    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = (repository.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(saved.id).toBe("vol-1");
    expect(saved.name).toBe("Alice Johnson");
    expect(saved.availability).toBe("available");
  });

  it("publishes volunteer.registered.v1 with the correct payload", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("vol");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RegisterVolunteer({ repository, clock, idGenerator, eventPublisher });

    await useCase.execute(validInput());

    expect(eventPublisher.eventNames()).toEqual(["volunteer.registered.v1"]);
    expect(eventPublisher.published[0]).toEqual({
      name: "volunteer.registered.v1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        volunteerId: "vol-1",
      },
    });
  });

  it("does not save or publish when the input violates an invariant", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("vol");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RegisterVolunteer({ repository, clock, idGenerator, eventPublisher });

    const result = await useCase.execute({ ...validInput(), name: "" });

    expect(result.ok).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
    expect(eventPublisher.published).toHaveLength(0);
  });

  it("assigns a fresh id for each registered volunteer", async () => {
    const repository = buildRepository();
    const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const idGenerator = new SequentialIdGenerator("vol");
    const eventPublisher = new CapturingEventPublisher();
    const useCase = new RegisterVolunteer({ repository, clock, idGenerator, eventPublisher });

    const first = await useCase.execute(validInput());
    const second = await useCase.execute(validInput());

    expect(first.ok && first.value.volunteerId).toBe("vol-1");
    expect(second.ok && second.value.volunteerId).toBe("vol-2");
  });
});
