import type { VolunteerId } from "@afrip/shared-kernel";
import type { Volunteer } from "../domain/volunteer.js";

/** Outbound port: persistence for the Volunteer aggregate. */
export interface VolunteerRepository {
  findById(id: VolunteerId): Promise<Volunteer | null>;
  save(volunteer: Volunteer): Promise<void>;
  listAll(): Promise<Volunteer[]>;
}
