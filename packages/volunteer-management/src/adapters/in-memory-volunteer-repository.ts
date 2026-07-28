import type { VolunteerId } from "@afrip/shared-kernel";
import type { Volunteer } from "../domain/volunteer.js";
import type { VolunteerRepository } from "../application/ports.js";

/** In-memory fake adapter for VolunteerRepository — used in tests and local runs. */
export class InMemoryVolunteerRepository implements VolunteerRepository {
  private readonly volunteers = new Map<string, Volunteer>();

  async findById(id: VolunteerId): Promise<Volunteer | null> {
    return this.volunteers.get(id) ?? null;
  }

  async save(volunteer: Volunteer): Promise<void> {
    this.volunteers.set(volunteer.id, volunteer);
  }

  async listAll(): Promise<Volunteer[]> {
    return Array.from(this.volunteers.values());
  }
}
