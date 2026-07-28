import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { VolunteerRepository } from './ports.js';
import type { Clock, EventPublisher, VolunteerId, VillageId } from '../../../shared/index.js';
import { asId } from '../../../shared/index.js';
import { assignVolunteer } from './assign-volunteer.js';
import { Volunteer } from '../domain/volunteer.js';

describe('AssignVolunteer - FR-VM-2', () => {
  let mockRepository: VolunteerRepository;
  let mockPublisher: EventPublisher;
  let mockClock: Clock;
  let volunteerId: VolunteerId;
  let villageId: VillageId;

  beforeEach(() => {
    volunteerId = asId('550e8400-e29b-41d4-a716-446655440000') as VolunteerId;
    villageId = asId('660e8400-e29b-41d4-a716-446655440000') as VillageId;

    const volunteer = Volunteer.create(
      volunteerId,
      'Alice Johnson',
      'alice@example.com',
      ['first-aid'],
      ['English'],
      'Village A',
      'weekdays',
    );

    mockRepository = {
      findById: vi.fn().mockResolvedValue(volunteer),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    mockClock = {
      now: vi.fn(() => new Date('2026-07-28T10:00:00Z')),
    };
  });

  it('FR-VM-2: should assign volunteer to village successfully', async () => {
    const result = await assignVolunteer(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      villageId,
      role: 'Medical Coordinator',
    });

    expect(result.ok).toBe(true);
    expect(mockRepository.findById).toHaveBeenCalledWith(volunteerId);
    expect(mockRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: volunteerId,
        activeAssignment: expect.objectContaining({
          villageId,
          role: 'Medical Coordinator',
          since: new Date('2026-07-28T10:00:00Z'),
        }),
      }),
    );
    expect(mockPublisher.publish).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'VolunteerAssigned',
          payload: expect.objectContaining({
            volunteerId,
            villageId,
            role: 'Medical Coordinator',
          }),
        }),
      ]),
    );
  });

  it('FR-VM-2: rejects assignment when volunteer not found with VOLUNTEER_NOT_FOUND error', async () => {
    mockRepository.findById = vi.fn().mockResolvedValue(null);

    const result = await assignVolunteer(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      villageId,
      role: 'Medical Coordinator',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('VOLUNTEER_NOT_FOUND');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VM-2: rejects assignment when volunteer already assigned with ALREADY_ASSIGNED error', async () => {
    const assignedVolunteer = Volunteer.create(
      volunteerId,
      'Alice Johnson',
      'alice@example.com',
      ['first-aid'],
      ['English'],
      'Village A',
      'weekdays',
    ).assignTo(villageId, 'Nurse', new Date('2026-07-20T00:00:00Z'));

    mockRepository.findById = vi.fn().mockResolvedValue(assignedVolunteer);

    const result = await assignVolunteer(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      villageId: asId('770e8400-e29b-41d4-a716-446655440000'),
      role: 'Medical Coordinator',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('ALREADY_ASSIGNED');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });
});
