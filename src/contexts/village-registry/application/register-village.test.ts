import { describe, expect, it, vi } from 'vitest';
import { asId, type VillageId } from '../../../shared/index.js';
import { registerVillage, type RegisterVillageDeps, type RegisterVillageInput } from './register-village.js';

// London School: mock the ports, verify collaborations (ADR-004).
describe('RegisterVillage use case', () => {
  const villageId = asId<'VillageId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as VillageId;
  const at = new Date('2026-07-28T08:00:00.000Z');

  const validInput: RegisterVillageInput = {
    id: villageId,
    name: 'Majuli',
    district: 'Jorhat',
    location: { lat: 26.2, lng: 92.9 },
    demographics: { population: 500, households: 100, affectedFamilies: 40 },
  };

  function createDeps(): RegisterVillageDeps {
    return {
      repository: { findById: vi.fn(), save: vi.fn().mockResolvedValue(undefined) },
      publisher: { publish: vi.fn().mockResolvedValue(undefined) },
      clock: { now: vi.fn().mockReturnValue(at) },
    };
  }

  it('FR-VR-1: saves the new village and publishes VillageRegistered', async () => {
    const deps = createDeps();

    const result = await registerVillage(validInput, deps);

    expect(result.ok).toBe(true);
    expect(deps.repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: villageId,
        name: 'Majuli',
        district: 'Jorhat',
        location: { lat: 26.2, lng: 92.9 },
        severity: 'unaffected',
      }),
    );
    expect(deps.publisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'VillageRegistered',
        occurredAt: at,
        payload: expect.objectContaining({ villageId, name: 'Majuli', district: 'Jorhat' }),
      }),
    ]);
    expect(deps.clock.now).toHaveBeenCalled();
  });

  it('FR-VR-1: rejects registration with an invalid GeoPoint and does not save or publish', async () => {
    const deps = createDeps();
    const input: RegisterVillageInput = { ...validInput, location: { lat: 91, lng: 0 } };

    const result = await registerVillage(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('GEO_BAD_LAT');
    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VR-1: rejects registration where affectedFamilies exceeds households and does not save or publish', async () => {
    const deps = createDeps();
    const input: RegisterVillageInput = {
      ...validInput,
      demographics: { population: 500, households: 50, affectedFamilies: 60 },
    };

    const result = await registerVillage(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DEMOGRAPHICS_AFFECTED_EXCEEDS_HOUSEHOLDS');
    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VR-1: rejects registration with an empty name and does not save or publish', async () => {
    const deps = createDeps();
    const input: RegisterVillageInput = { ...validInput, name: '  ' };

    const result = await registerVillage(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VILLAGE_NAME_REQUIRED');
    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });
});
