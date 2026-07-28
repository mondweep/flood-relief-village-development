import { describe, expect, it, vi } from "vitest";
import { unwrap, villageId, volunteerId } from "@afrip/shared-kernel";
import { Volunteer } from "../src/domain/volunteer.js";
import { Leaderboard } from "../src/application/leaderboard.js";
import type { VolunteerRepository } from "../src/application/ports.js";

function buildRepository(volunteers: Volunteer[] = [], overrides: Partial<VolunteerRepository> = {}): VolunteerRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue(volunteers),
    ...overrides,
  };
}

describe("Leaderboard", () => {
  it("returns empty leaderboard when no volunteers exist", async () => {
    const repository = buildRepository([]);
    const useCase = new Leaderboard({ repository });

    const result = await useCase.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toHaveLength(0);
  });

  it("returns sorted volunteers by total hours descending", async () => {
    const vol1 = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    }));

    const vol2 = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-2")),
      name: "Bob",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    }));

    // Add assignments and hours to vol1
    vol1.addAssignment({
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 10,
    });

    // Add assignments and hours to vol2
    vol2.addAssignment({
      id: "assign-2",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 5,
    });

    const repository = buildRepository([vol1, vol2]);
    const useCase = new Leaderboard({ repository });

    const result = await useCase.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries).toHaveLength(2);
    expect(result.value.entries[0]).toMatchObject({
      volunteerId: "vol-1",
      name: "Alice",
      totalHours: 10,
    });
    expect(result.value.entries[1]).toMatchObject({
      volunteerId: "vol-2",
      name: "Bob",
      totalHours: 5,
    });
  });

  it("handles multiple assignments per volunteer", async () => {
    const vol1 = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    }));

    vol1.addAssignment({
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 5,
    });

    vol1.addAssignment({
      id: "assign-2",
      villageId: unwrap(villageId("village-2")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 8,
    });

    const repository = buildRepository([vol1]);
    const useCase = new Leaderboard({ repository });

    const result = await useCase.execute();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries[0]).toMatchObject({
      volunteerId: "vol-1",
      name: "Alice",
      totalHours: 13,
    });
  });
});
