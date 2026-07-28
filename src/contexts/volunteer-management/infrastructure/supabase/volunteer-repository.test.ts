import { describe, expect, it } from 'vitest';
import { asId, type VillageId, type VolunteerId } from '../../../../shared/index.js';
import { Volunteer } from '../../domain/volunteer.js';
import { fromVolunteerRow, toVolunteerRow } from './volunteer-repository.js';

const volunteerId = (): VolunteerId => asId<'VolunteerId'>('70000000-0000-4000-8000-000000000001');
const villageId = (): VillageId => asId<'VillageId'>('20000000-0000-4000-8000-000000000001');

describe('toVolunteerRow / fromVolunteerRow', () => {
  it('round-trips an unassigned volunteer', () => {
    const volunteer = Volunteer.create(
      volunteerId(),
      'Priya Sharma',
      '+91-9000000000',
      ['first_aid', 'logistics'],
      ['assamese', 'english'],
      'Jorhat',
      'weekends',
    );

    const row = toVolunteerRow(volunteer);
    expect(row).toEqual({
      id: volunteerId(),
      name: 'Priya Sharma',
      contact: '+91-9000000000',
      skills: ['first_aid', 'logistics'],
      languages: ['assamese', 'english'],
      location: 'Jorhat',
      availability: 'weekends',
      active_village_id: null,
      active_role: null,
      active_since: null,
      total_hours: 0,
      certificates: [],
    });

    expect(fromVolunteerRow(row)).toEqual(volunteer);
  });

  it('round-trips an assigned volunteer with logged hours and certificates', () => {
    const base = Volunteer.create(
      volunteerId(),
      'Priya Sharma',
      '+91-9000000000',
      ['first_aid'],
      ['assamese'],
      'Jorhat',
      'full_time',
    );
    const assigned = base.assignTo(villageId(), 'field-coordinator', new Date('2026-07-01T00:00:00.000Z'));
    const withHours = assigned.logHours(55, ['FIFTY_HOURS']);

    const rebuilt = fromVolunteerRow(toVolunteerRow(withHours));

    expect(rebuilt).toEqual(withHours);
    expect(rebuilt.activeAssignment).toEqual({
      villageId: villageId(),
      role: 'field-coordinator',
      since: new Date('2026-07-01T00:00:00.000Z'),
    });
  });
});
