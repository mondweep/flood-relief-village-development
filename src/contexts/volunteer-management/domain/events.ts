import type { VolunteerId, VillageId, DomainEvent } from '../../../shared/index.js';
import { domainEvent } from '../../../shared/index.js';

export const volunteerRegistered = (
  volunteerId: VolunteerId,
  name: string,
  contact: string,
  skills: readonly string[],
  languages: readonly string[],
  location: string,
  availability: string,
  occurredAt: Date,
): DomainEvent =>
  domainEvent('VolunteerRegistered', occurredAt, {
    volunteerId,
    name,
    contact,
    skills,
    languages,
    location,
    availability,
  });

export const volunteerAssigned = (
  volunteerId: VolunteerId,
  villageId: VillageId,
  role: string,
  since: Date,
  occurredAt: Date,
): DomainEvent =>
  domainEvent('VolunteerAssigned', occurredAt, {
    volunteerId,
    villageId,
    role,
    since,
  });

export const hoursLogged = (
  volunteerId: VolunteerId,
  hours: number,
  totalHours: number,
  occurredAt: Date,
): DomainEvent =>
  domainEvent('HoursLogged', occurredAt, {
    volunteerId,
    hours,
    totalHours,
  });

export const certificateEarned = (
  volunteerId: VolunteerId,
  certificate: string,
  occurredAt: Date,
): DomainEvent =>
  domainEvent('CertificateEarned', occurredAt, {
    volunteerId,
    certificate,
  });
