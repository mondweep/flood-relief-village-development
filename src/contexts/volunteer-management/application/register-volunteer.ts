import type { Result, VolunteerId, Clock, EventPublisher } from '../../../shared/index.js';
import { err, ok } from '../../../shared/index.js';
import type { VolunteerRepository } from './ports.js';
import { Volunteer } from '../domain/volunteer.js';
import { volunteerRegistered } from '../domain/events.js';

export interface RegisterVolunteerInput {
  readonly volunteerId: VolunteerId;
  readonly name: string;
  readonly contact: string;
  readonly skills: readonly string[];
  readonly languages: readonly string[];
  readonly location: string;
  readonly availability: 'weekdays' | 'weekends' | 'full_time';
}

export function registerVolunteer(
  repository: VolunteerRepository,
  publisher: EventPublisher,
  clock: Clock,
) {
  return async (input: RegisterVolunteerInput): Promise<Result<Volunteer>> => {
    if (!input.name.trim()) {
      return err('EMPTY_NAME', 'Volunteer name cannot be empty');
    }
    if (!input.contact.trim()) {
      return err('EMPTY_CONTACT', 'Volunteer contact cannot be empty');
    }
    if (input.skills.length === 0) {
      return err('NO_SKILLS', 'Volunteer must have at least one skill');
    }
    if (input.languages.length === 0) {
      return err('NO_LANGUAGES', 'Volunteer must speak at least one language');
    }

    const volunteer = Volunteer.create(
      input.volunteerId,
      input.name,
      input.contact,
      input.skills,
      input.languages,
      input.location,
      input.availability,
    );

    await repository.save(volunteer);

    const event = volunteerRegistered(
      input.volunteerId,
      input.name,
      input.contact,
      input.skills,
      input.languages,
      input.location,
      input.availability,
      clock.now(),
    );

    await publisher.publish([event]);

    return ok(volunteer);
  };
}
