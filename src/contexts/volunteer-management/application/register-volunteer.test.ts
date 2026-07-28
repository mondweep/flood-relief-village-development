import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { VolunteerRepository } from './ports.js';
import type { Clock, EventPublisher, VolunteerId } from '../../../shared/index.js';
import { asId, ok } from '../../../shared/index.js';
import { registerVolunteer } from './register-volunteer.js';
import { Volunteer } from '../domain/volunteer.js';

describe('RegisterVolunteer - FR-VM-1', () => {
  let mockRepository: VolunteerRepository;
  let mockPublisher: EventPublisher;
  let mockClock: Clock;

  beforeEach(() => {
    mockRepository = {
      findById: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mockPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    mockClock = {
      now: vi.fn(() => new Date('2026-07-28T00:00:00Z')),
    };
  });

  it('FR-VM-1: should register volunteer with valid data', async () => {
    const volunteerId = asId('550e8400-e29b-41d4-a716-446655440000') as VolunteerId;
    const result = await registerVolunteer(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      name: 'Alice Johnson',
      contact: 'alice@example.com',
      skills: ['first-aid', 'logistics'],
      languages: ['English', 'French'],
      location: 'Village A',
      availability: 'weekdays',
    });

    expect(result.ok).toBe(true);
    expect(mockRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: volunteerId,
        name: 'Alice Johnson',
        contact: 'alice@example.com',
        skills: ['first-aid', 'logistics'],
        languages: ['English', 'French'],
        location: 'Village A',
        availability: 'weekdays',
      }),
    );
    expect(mockPublisher.publish).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'VolunteerRegistered',
          payload: expect.objectContaining({
            volunteerId,
            name: 'Alice Johnson',
            contact: 'alice@example.com',
          }),
        }),
      ]),
    );
  });

  it('FR-VM-1: rejects empty name with EMPTY_NAME error', async () => {
    const volunteerId = asId('550e8400-e29b-41d4-a716-446655440000') as VolunteerId;
    const result = await registerVolunteer(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      name: '',
      contact: 'alice@example.com',
      skills: ['first-aid'],
      languages: ['English'],
      location: 'Village A',
      availability: 'weekdays',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('EMPTY_NAME');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VM-1: rejects empty contact with EMPTY_CONTACT error', async () => {
    const volunteerId = asId('550e8400-e29b-41d4-a716-446655440000') as VolunteerId;
    const result = await registerVolunteer(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      name: 'Alice Johnson',
      contact: '',
      skills: ['first-aid'],
      languages: ['English'],
      location: 'Village A',
      availability: 'weekdays',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('EMPTY_CONTACT');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VM-1: rejects empty skills with NO_SKILLS error', async () => {
    const volunteerId = asId('550e8400-e29b-41d4-a716-446655440000') as VolunteerId;
    const result = await registerVolunteer(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      name: 'Alice Johnson',
      contact: 'alice@example.com',
      skills: [],
      languages: ['English'],
      location: 'Village A',
      availability: 'weekdays',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('NO_SKILLS');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VM-1: rejects empty languages with NO_LANGUAGES error', async () => {
    const volunteerId = asId('550e8400-e29b-41d4-a716-446655440000') as VolunteerId;
    const result = await registerVolunteer(mockRepository, mockPublisher, mockClock)({
      volunteerId,
      name: 'Alice Johnson',
      contact: 'alice@example.com',
      skills: ['first-aid'],
      languages: [],
      location: 'Village A',
      availability: 'weekdays',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result as { readonly ok: false; readonly error: { code: string } }).error.code).toBe('NO_LANGUAGES');
    }
    expect(mockRepository.save).not.toHaveBeenCalled();
    expect(mockPublisher.publish).not.toHaveBeenCalled();
  });
});
