import { describe, it, expect } from 'vitest';
import type { VolunteerId, VillageId } from '../../../shared/index.js';
import { asId } from '../../../shared/index.js';
import { Volunteer } from './volunteer.js';

describe('Volunteer Aggregate', () => {
  const volunteerId = asId('550e8400-e29b-41d4-a716-446655440000') as VolunteerId;
  const villageId = asId('660e8400-e29b-41d4-a716-446655440000') as VillageId;

  describe('Volunteer.create', () => {
    it('should create a new volunteer with initial state', () => {
      const volunteer = Volunteer.create(
        volunteerId,
        'Alice Johnson',
        'alice@example.com',
        ['first-aid', 'logistics'],
        ['English', 'French'],
        'Village A',
        'weekdays',
      );

      expect(volunteer.id).toBe(volunteerId);
      expect(volunteer.name).toBe('Alice Johnson');
      expect(volunteer.contact).toBe('alice@example.com');
      expect(volunteer.skills).toEqual(['first-aid', 'logistics']);
      expect(volunteer.languages).toEqual(['English', 'French']);
      expect(volunteer.location).toBe('Village A');
      expect(volunteer.availability).toBe('weekdays');
      expect(volunteer.activeAssignment).toBeNull();
      expect(volunteer.totalHours).toBe(0);
      expect(volunteer.certificates).toEqual([]);
    });
  });

  describe('Volunteer.hydrate', () => {
    it('should restore volunteer from persisted state', () => {
      const assignment = { villageId, role: 'Nurse', since: new Date('2026-07-20T00:00:00Z') };
      const volunteer = Volunteer.hydrate(
        volunteerId,
        'Alice Johnson',
        'alice@example.com',
        ['first-aid'],
        ['English'],
        'Village A',
        'weekdays',
        assignment,
        50,
        ['FIFTY_HOURS'],
      );

      expect(volunteer.id).toBe(volunteerId);
      expect(volunteer.activeAssignment).toEqual(assignment);
      expect(volunteer.totalHours).toBe(50);
      expect(volunteer.certificates).toEqual(['FIFTY_HOURS']);
    });
  });

  describe('assignTo', () => {
    it('should set active assignment', () => {
      const volunteer = Volunteer.create(
        volunteerId,
        'Alice Johnson',
        'alice@example.com',
        ['first-aid'],
        ['English'],
        'Village A',
        'weekdays',
      );

      const now = new Date('2026-07-28T10:00:00Z');
      const assigned = volunteer.assignTo(villageId, 'Medical Coordinator', now);

      expect(assigned.activeAssignment).toEqual({
        villageId,
        role: 'Medical Coordinator',
        since: now,
      });
      expect(assigned.totalHours).toBe(0);
      expect(assigned.certificates).toEqual([]);
    });

    it('should be immutable - original volunteer unchanged', () => {
      const volunteer = Volunteer.create(
        volunteerId,
        'Alice Johnson',
        'alice@example.com',
        ['first-aid'],
        ['English'],
        'Village A',
        'weekdays',
      );

      const now = new Date('2026-07-28T10:00:00Z');
      const assigned = volunteer.assignTo(villageId, 'Nurse', now);

      expect(volunteer.activeAssignment).toBeNull();
      expect(assigned.activeAssignment).not.toBeNull();
    });
  });

  describe('unassign', () => {
    it('should clear active assignment', () => {
      const now = new Date('2026-07-28T10:00:00Z');
      const assigned = Volunteer.create(
        volunteerId,
        'Alice Johnson',
        'alice@example.com',
        ['first-aid'],
        ['English'],
        'Village A',
        'weekdays',
      ).assignTo(villageId, 'Nurse', now);

      const unassigned = assigned.unassign();

      expect(unassigned.activeAssignment).toBeNull();
      expect(unassigned.totalHours).toBe(0);
    });
  });

  describe('logHours', () => {
    it('should accumulate total hours', () => {
      const volunteer = Volunteer.create(
        volunteerId,
        'Alice Johnson',
        'alice@example.com',
        ['first-aid'],
        ['English'],
        'Village A',
        'weekdays',
      )
        .assignTo(villageId, 'Nurse', new Date('2026-07-20T00:00:00Z'))
        .logHours(10, []);

      expect(volunteer.totalHours).toBe(10);

      const updated = volunteer.logHours(15, []);

      expect(updated.totalHours).toBe(25);
    });

    it('should add certificates when crossing 50 hours', () => {
      const volunteer = Volunteer.create(
        volunteerId,
        'Alice Johnson',
        'alice@example.com',
        ['first-aid'],
        ['English'],
        'Village A',
        'weekdays',
      )
        .assignTo(villageId, 'Nurse', new Date('2026-07-20T00:00:00Z'))
        .logHours(45, []);

      const updated = volunteer.logHours(10, ['FIFTY_HOURS']);

      expect(updated.totalHours).toBe(55);
      expect(updated.certificates).toEqual(['FIFTY_HOURS']);
    });

    it('should accumulate multiple certificates', () => {
      const volunteer = Volunteer.create(
        volunteerId,
        'Alice Johnson',
        'alice@example.com',
        ['first-aid'],
        ['English'],
        'Village A',
        'weekdays',
      )
        .assignTo(villageId, 'Nurse', new Date('2026-07-20T00:00:00Z'))
        .logHours(50, ['FIFTY_HOURS']);

      const updated = volunteer.logHours(50, ['HUNDRED_HOURS']);

      expect(updated.totalHours).toBe(100);
      expect(updated.certificates).toEqual(['FIFTY_HOURS', 'HUNDRED_HOURS']);
    });
  });
});
