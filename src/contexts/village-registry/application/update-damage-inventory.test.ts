import { describe, expect, it, vi } from 'vitest';
import { asId, unwrap, type VillageId } from '../../../shared/index.js';
import { createVillage, type Village } from '../domain/village.js';
import { demographics } from '../domain/demographics.js';
import {
  updateDamageInventory,
  type UpdateDamageInventoryDeps,
  type UpdateDamageInventoryInput,
} from './update-damage-inventory.js';

// London School: mock the ports, verify collaborations (ADR-004).
describe('UpdateDamageInventory use case', () => {
  const villageId = asId<'VillageId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as VillageId;
  const registeredAt = new Date('2026-07-28T08:00:00.000Z');
  const updatedAt = new Date('2026-07-29T09:00:00.000Z');

  const existingVillage = unwrap(
    createVillage({
      id: villageId,
      name: 'Majuli',
      district: 'Jorhat',
      location: { lat: 26.2, lng: 92.9 },
      demographics: unwrap(demographics({ population: 500, households: 100, affectedFamilies: 40 })),
      at: registeredAt,
    }),
  );

  const validInventory = {
    houses: 30,
    schools: 2,
    healthCentres: 1,
    waterSources: 4,
    agricultureHectares: 120.5,
    livestock: 60,
  };

  function createDeps(found: Village | null = existingVillage): UpdateDamageInventoryDeps {
    return {
      repository: { findById: vi.fn().mockResolvedValue(found), save: vi.fn().mockResolvedValue(undefined) },
      publisher: { publish: vi.fn().mockResolvedValue(undefined) },
      clock: { now: vi.fn().mockReturnValue(updatedAt) },
    };
  }

  it('FR-VR-2: saves the updated inventory and publishes ProfileUpdated', async () => {
    const deps = createDeps();
    const input: UpdateDamageInventoryInput = { villageId, damageInventory: validInventory };

    const result = await updateDamageInventory(input, deps);

    expect(result.ok).toBe(true);
    expect(deps.repository.findById).toHaveBeenCalledWith(villageId);
    expect(deps.repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: villageId, damageInventory: validInventory, updatedAt }),
    );
    expect(deps.publisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'ProfileUpdated',
        occurredAt: updatedAt,
        payload: { villageId, damageInventory: validInventory },
      }),
    ]);
  });

  it('FR-VR-2: rejects a negative count and does not save or publish', async () => {
    const deps = createDeps();
    const input: UpdateDamageInventoryInput = { villageId, damageInventory: { ...validInventory, houses: -1 } };

    const result = await updateDamageInventory(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DAMAGE_INVENTORY_NEGATIVE');
    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-VR-2: rejects updating an unknown village and does not save or publish', async () => {
    const deps = createDeps(null);
    const input: UpdateDamageInventoryInput = { villageId, damageInventory: validInventory };

    const result = await updateDamageInventory(input, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VILLAGE_NOT_FOUND');
    expect(deps.repository.save).not.toHaveBeenCalled();
    expect(deps.publisher.publish).not.toHaveBeenCalled();
  });
});
