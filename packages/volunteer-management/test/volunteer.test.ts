import { describe, expect, it } from "vitest";
import { isErr, unwrap, villageId, volunteerId } from "@afrip/shared-kernel";
import { Volunteer } from "../src/domain/volunteer.js";

describe("Volunteer aggregate", () => {
  it("creates a volunteer with default availability 'available'", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.availability).toBe("available");
  });

  it("returns error if name is empty", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    });

    expect(result.ok).toBe(false);
    expect(isErr(result) ? result.error : undefined).toContain("name must not be empty");
  });

  it("returns error if location is empty", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "",
      availability: "available",
    });

    expect(result.ok).toBe(false);
    expect(isErr(result) ? result.error : undefined).toContain("location must not be empty");
  });

  it("returns error if availability is invalid", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "invalid" as any,
    });

    expect(result.ok).toBe(false);
  });

  it("stores assignments and tracks total hours", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    volunteer.assignTo({
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 5,
    });

    expect(volunteer.assignments).toHaveLength(1);
    expect(volunteer.getTotalHours()).toBe(5);
  });

  it("accumulates hours across multiple assignments", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: ["carpentry"],
      languages: ["English"],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    volunteer.assignTo({
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 5,
    });
    volunteer.assignTo({
      id: "assign-2",
      villageId: unwrap(villageId("village-2")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 3,
    });

    expect(volunteer.getTotalHours()).toBe(8);
  });

  it("sets availability and returns previous state", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    const updateResult = volunteer.setAvailability("unavailable");

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;
    expect(updateResult.value.previous).toBe("available");
    expect(volunteer.availability).toBe("unavailable");
  });

  it("returns error if invalid availability is set", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    const updateResult = volunteer.setAvailability("invalid" as any);

    expect(updateResult.ok).toBe(false);
  });

  it("canBeAssigned returns true when available", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    expect(volunteer.canBeAssigned()).toBe(true);
  });

  it("canBeAssigned returns false when unavailable", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "unavailable",
    });

    const volunteer = unwrap(result);
    expect(volunteer.canBeAssigned()).toBe(false);
  });

  it("logs hours against an assignment", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    volunteer.assignTo({
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 0,
    });

    const logResult = volunteer.logHours("assign-1", 5);

    expect(logResult.ok).toBe(true);
    expect(volunteer.assignments[0]!.hours).toBe(5);
    expect(volunteer.getTotalHours()).toBe(5);
  });

  it("returns error if hours <= 0", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    volunteer.assignTo({
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 0,
    });

    const logResult = volunteer.logHours("assign-1", 0);

    expect(logResult.ok).toBe(false);
  });

  it("returns error if assignment not found when logging hours", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    const logResult = volunteer.logHours("unknown", 5);

    expect(logResult.ok).toBe(false);
  });

  it("finds assignment by id", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    volunteer.assignTo({
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 0,
    });

    const found = volunteer.findAssignmentById("assign-1");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("assign-1");
  });

  it("returns null when finding non-existent assignment", () => {
    const result = Volunteer.create({
      id: unwrap(volunteerId("vol-1")),
      name: "Alice",
      skills: [],
      languages: [],
      location: "Patna",
      availability: "available",
    });

    const volunteer = unwrap(result);
    const found = volunteer.findAssignmentById("unknown");
    expect(found).toBeNull();
  });
});

describe("Volunteer encapsulation (regression)", () => {
  function buildVolunteer(availability: "available" | "unavailable" = "available") {
    return unwrap(
      Volunteer.create({
        id: unwrap(volunteerId("vol-1")),
        name: "Alice",
        skills: ["carpentry"],
        languages: ["English"],
        location: "Patna",
        availability,
      }),
    );
  }

  it("mutating an assignment returned by the getter cannot corrupt totals", () => {
    const volunteer = buildVolunteer();
    volunteer.assignTo({
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 5,
    });

    (volunteer.assignments[0] as { hours: number }).hours = -500;

    expect(volunteer.assignments[0]!.hours).toBe(5);
    expect(volunteer.getTotalHours()).toBe(5);
  });

  it("assignTo enforces the availability rule inside the aggregate", () => {
    const volunteer = buildVolunteer("unavailable");

    const result = volunteer.assignTo({
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 0,
    });

    expect(result.ok).toBe(false);
    expect(isErr(result) ? result.error : undefined).toBe("volunteer is not available");
    expect(volunteer.assignments).toHaveLength(0);
  });

  it("copies the assignment on assignTo — hours changes only flow through logHours", () => {
    const volunteer = buildVolunteer();
    const assignment = {
      id: "assign-1",
      villageId: unwrap(villageId("village-1")),
      task: "work",
      assignedAt: "2026-01-01T00:00:00.000Z",
      hours: 0,
    };
    volunteer.assignTo(assignment);

    (assignment as { hours: number }).hours = 99;
    expect(volunteer.getTotalHours()).toBe(0);

    const logResult = volunteer.logHours("assign-1", 4);
    expect(logResult.ok).toBe(true);
    expect(volunteer.getTotalHours()).toBe(4);
  });

  it("copies skills and languages on construction — caller arrays are not aliased", () => {
    const skills = ["carpentry"];
    const languages = ["English"];
    const volunteer = unwrap(
      Volunteer.create({
        id: unwrap(volunteerId("vol-1")),
        name: "Alice",
        skills,
        languages,
        location: "Patna",
        availability: "available",
      }),
    );

    skills.push("forged");
    languages.push("forged");

    expect(volunteer.skills).toEqual(["carpentry"]);
    expect(volunteer.languages).toEqual(["English"]);
  });
});
