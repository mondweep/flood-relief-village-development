import { describe, expect, it } from 'vitest';
import { damageInventory, zeroDamageInventory } from './damage-inventory.js';

// Pure value object: state-based tests are appropriate here (ADR-004 §5).
describe('DamageInventory', () => {
  const valid = {
    houses: 12,
    schools: 1,
    healthCentres: 0,
    waterSources: 3,
    agricultureHectares: 45.5,
    livestock: 20,
  };

  it('FR-VR-2: accepts a fully non-negative inventory', () => {
    const result = damageInventory(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(valid);
  });

  it('FR-VR-2: rejects a negative house count', () => {
    const result = damageInventory({ ...valid, houses: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DAMAGE_INVENTORY_NEGATIVE');
  });

  it.each(['schools', 'healthCentres', 'waterSources', 'agricultureHectares', 'livestock'] as const)(
    'FR-VR-2: rejects a negative %s count',
    (field) => {
      const result = damageInventory({ ...valid, [field]: -5 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DAMAGE_INVENTORY_NEGATIVE');
    },
  );

  it('FR-VR-2: rejects non-finite counts', () => {
    const result = damageInventory({ ...valid, houses: Number.NaN });
    expect(result.ok).toBe(false);
  });

  it('FR-VR-2: exposes an all-zero default inventory for newly registered villages', () => {
    expect(zeroDamageInventory).toEqual({
      houses: 0,
      schools: 0,
      healthCentres: 0,
      waterSources: 0,
      agricultureHectares: 0,
      livestock: 0,
    });
  });
});
