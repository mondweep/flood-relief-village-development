import type { Result, VolunteerId, VillageId, Clock, EventPublisher } from '../../../shared/index.js';
import { err, ok } from '../../../shared/index.js';
import type { VolunteerRepository } from './ports.js';
import type { Volunteer } from '../domain/volunteer.js';
import { volunteerAssigned } from '../domain/events.js';

export interface AssignVolunteerInput {
  readonly volunteerId: VolunteerId;
  readonly villageId: VillageId;
  readonly role: string;
}

export function assignVolunteer(
  repository: VolunteerRepository,
  publisher: EventPublisher,
  clock: Clock,
) {
  return async (input: AssignVolunteerInput): Promise<Result<Volunteer>> => {
    const volunteer = await repository.findById(input.volunteerId);
    if (!volunteer) {
      return err('VOLUNTEER_NOT_FOUND', `Volunteer ${input.volunteerId} not found`);
    }

    if (volunteer.activeAssignment !== null) {
      return err('ALREADY_ASSIGNED', `Volunteer is already assigned to a village`);
    }

    const now = clock.now();
    const assigned = volunteer.assignTo(input.villageId, input.role, now);
    await repository.save(assigned);

    const event = volunteerAssigned(
      input.volunteerId,
      input.villageId,
      input.role,
      now,
      now,
    );

    await publisher.publish([event]);

    return ok(assigned);
  };
}
