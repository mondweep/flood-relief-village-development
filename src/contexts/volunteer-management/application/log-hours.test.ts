import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { VolunteerRepository } from './ports.js';
import type { Clock, EventPublisher, VolunteerId, VillageId } from '../../../shared/index.js';
import { asId } from '../../../shared/index.js';
import { logHours } from './log-hours.js';
import { Volunteer } from '../domain/volunteer.js';

describe('LogHours - FR-VM-3', () => {
  let mockRepository: VolunteerRepository;
  let mockPublisher: EventPublisher;
  let mockClock: Clock;
  let volunteerId: VolunteerId;
  let villageId: VillageId;

  beforeEach(() => {
    volunteerId = asId('550e8400-e29b-41d4-a716-446655440000') as VolunteerId;
    villageId = asId('660e8400-e29b-41d4-a716-446655440000') as VillageId;

    mockRepository = {
      findById: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    mockClock = {
      now: vi.fn(() => new Date('2026-07-28T10:00:00Z')),
    };
  });

  it('FR-VM-3: should log hours successfully', async () => {
    const volunteer = Volunteer.create(
      volunteerId,
      'Alice Johnson',
      'alice@example.com',
      ['first-aid'],
      ['English'],
      'Village A',
      'weekdays',
    ).assignTo(villageId, 'Nurse', new Date('2026-07-20T00:00:00Z'));

    mockRepository.findById = vi.fn().mockResolvedValue(volunteer);

    const result = await logHours(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      hours: 8,
    });

    expect(result.ok).toBe(true);
    expect(mockRepository.findById).toHaveBeenCalledWith(volunteerId);
    expect(mockRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: volunteerId,
        totalHours: 8,
      }),
    );
    expect(mockPublisher.publish).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'HoursLogged',
          payload: expect.objectContaining({
            volunteerId,
            hours: 8,
            totalHours: 8,
          }),
        }),
      ]),
    );
  });

  it('FR-VM-3: rejects when volunteer not found with VOLUNTEER_NOT_FOUND error', async () => {
    mockRepository.findById = vi.fn().mockResolvedValue(null);

    const result = await logHours(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      hours: 8,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('VOLUNTEER_NOT_FOUND');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VM-3: rejects when volunteer has no active assignment with NO_ACTIVE_ASSIGNMENT error', async () => {
    const volunteer = Volunteer.create(
      volunteerId,
      'Alice Johnson',
      'alice@example.com',
      ['first-aid'],
      ['English'],
      'Village A',
      'weekdays',
    );

    mockRepository.findById = vi.fn().mockResolvedValue(volunteer);

    const result = await logHours(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      hours: 8,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('NO_ACTIVE_ASSIGNMENT');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VM-3: rejects negative hours with INVALID_HOURS error', async () => {
    const volunteer = Volunteer.create(
      volunteerId,
      'Alice Johnson',
      'alice@example.com',
      ['first-aid'],
      ['English'],
      'Village A',
      'weekdays',
    ).assignTo(villageId, 'Nurse', new Date('2026-07-20T00:00:00Z'));

    mockRepository.findById = vi.fn().mockResolvedValue(volunteer);

    const result = await logHours(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      hours: -5,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('INVALID_HOURS');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VM-3: rejects zero hours with INVALID_HOURS error', async () => {
    const volunteer = Volunteer.create(
      volunteerId,
      'Alice Johnson',
      'alice@example.com',
      ['first-aid'],
      ['English'],
      'Village A',
      'weekdays',
    ).assignTo(villageId, 'Nurse', new Date('2026-07-20T00:00:00Z'));

    mockRepository.findById = vi.fn().mockResolvedValue(volunteer);

    const result = await logHours(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      hours: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('INVALID_HOURS');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VM-3: crosses 50-hour threshold and publishes CertificateEarned', async () => {
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

    mockRepository.findById = vi.fn().mockResolvedValue(volunteer);

    const result = await logHours(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      hours: 10,
    });

    expect(result.ok).toBe(true);
    expect(mockRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: volunteerId,
        totalHours: 55,
        certificates: ['FIFTY_HOURS'],
      }),
    );
    // Should publish both HoursLogged and CertificateEarned
    expect(mockPublisher.publish).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'HoursLogged',
          payload: expect.objectContaining({
            volunteerId,
            hours: 10,
            totalHours: 55,
          }),
        }),
        expect.objectContaining({
          type: 'CertificateEarned',
          payload: expect.objectContaining({
            volunteerId,
            certificate: 'FIFTY_HOURS',
          }),
        }),
      ]),
    );
  });

  it('FR-VM-3: does not duplicate FIFTY_HOURS certificate if already earned', async () => {
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

    mockRepository.findById = vi.fn().mockResolvedValue(volunteer);

    const result = await logHours(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      hours: 5,
    });

    expect(result.ok).toBe(true);
    expect(mockRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: volunteerId,
        totalHours: 55,
        certificates: ['FIFTY_HOURS'],
      }),
    );
    // Should publish only HoursLogged, not CertificateEarned
    expect(mockPublisher.publish).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'HoursLogged',
          payload: expect.objectContaining({
            volunteerId,
            hours: 5,
            totalHours: 55,
          }),
        }),
      ]),
    );
    const calls = (mockPublisher.publish as any).mock.calls;
    const publishedEvents = calls[0][0];
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0].type).toBe('HoursLogged');
  });
});
