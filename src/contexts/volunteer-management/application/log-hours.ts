import type { Result, VolunteerId, Clock, EventPublisher } from '../../../shared/index.js';
import { err, ok } from '../../../shared/index.js';
import type { VolunteerRepository } from './ports.js';
import type { Volunteer } from '../domain/volunteer.js';
import { hoursLogged, certificateEarned } from '../domain/events.js';

export interface LogHoursInput {
  readonly volunteerId: VolunteerId;
  readonly hours: number;
}

export function logHours(
  repository: VolunteerRepository,
  publisher: EventPublisher,
  clock: Clock,
) {
  return async (input: LogHoursInput): Promise<Result<Volunteer>> => {
    const volunteer = await repository.findById(input.volunteerId);
    if (!volunteer) {
      return err('VOLUNTEER_NOT_FOUND', `Volunteer ${input.volunteerId} not found`);
    }

    if (volunteer.activeAssignment === null) {
      return err('NO_ACTIVE_ASSIGNMENT', `Volunteer must be assigned to log hours`);
    }

    if (input.hours <= 0) {
      return err('INVALID_HOURS', `Hours must be greater than zero`);
    }

    const now = clock.now();
    const newTotalHours = volunteer.totalHours + input.hours;
    const wasBelowThreshold = volunteer.totalHours < 50;
    const isNowAboveThreshold = newTotalHours >= 50;
    const alreadyHasCertificate = volunteer.certificates.includes('FIFTY_HOURS');

    const newCertificates =
      wasBelowThreshold && isNowAboveThreshold && !alreadyHasCertificate
        ? ['FIFTY_HOURS']
        : [];

    const updated = volunteer.logHours(input.hours, newCertificates);
    await repository.save(updated);

    const events = [hoursLogged(input.volunteerId, input.hours, newTotalHours, now)];

    if (newCertificates.length > 0) {
      events.push(certificateEarned(input.volunteerId, 'FIFTY_HOURS', now));
    }

    await publisher.publish(events);

    return ok(updated);
  };
}
