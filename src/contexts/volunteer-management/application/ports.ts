import type { VolunteerId } from '../../../shared/index.js';
import type { Volunteer } from '../domain/volunteer.js';

export interface VolunteerRepository {
  findById(id: VolunteerId): Promise<Volunteer | null>;
  save(volunteer: Volunteer): Promise<void>;
}
