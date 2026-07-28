import { describe, expect, it } from "vitest";
import { unwrap, volunteerId } from "@afrip/shared-kernel";
import { Volunteer } from "../src/domain/volunteer.js";
import { InMemoryVolunteerRepository } from "../src/adapters/in-memory-volunteer-repository.js";

describe("InMemoryVolunteerRepository", () => {
  it("saves and retrieves a volunteer by id", async () => {
    const repository = new InMemoryVolunteerRepository();
    const volunteer = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    }));

    await repository.save(volunteer);
    const found = await repository.findById(volunteer.id);

    expect(found).not.toBeNull();
    expect(found?.id).toBe("vol-1");
    expect(found?.name).toBe("Alice");
  });

  it("returns null when volunteer not found", async () => {
    const repository = new InMemoryVolunteerRepository();

    const found = await repository.findById(unwrap(volunteerId("vol-999")));

    expect(found).toBeNull();
  });

  it("lists all saved volunteers", async () => {
    const repository = new InMemoryVolunteerRepository();

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

    await repository.save(vol1);
    await repository.save(vol2);

    const all = await repository.listAll();

    expect(all).toHaveLength(2);
    expect(all.map((v) => v.id)).toEqual(["vol-1", "vol-2"]);
  });

  it("updates an existing volunteer", async () => {
    const repository = new InMemoryVolunteerRepository();
    const volunteer = unwrap(Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    }));

    await repository.save(volunteer);

    volunteer.setAvailability("unavailable");
    await repository.save(volunteer);

    const found = await repository.findById(volunteer.id);
    expect(found?.availability).toBe("unavailable");
  });

  it("returns empty list when no volunteers exist", async () => {
    const repository = new InMemoryVolunteerRepository();

    const all = await repository.listAll();

    expect(all).toHaveLength(0);
  });
});
