import { describe, expect, it } from 'vitest';
import { asId, unwrap, type VillageId } from '../../../shared/index.js';
import { createVillage, applySeverityChange } from './village.js';
import { demographics } from './demographics.js';
import { villageRegistered, profileUpdated, severityChanged } from './events.js';

// Pure event factories: state-based tests are appropriate here (ADR-004 §5).
describe('Village Registry domain events', () => {
  const villageId = asId<'VillageId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as VillageId;
  const at = new Date('2026-07-28T08:00:00.000Z');
  const village = unwrap(
    createVillage({
      id: villageId,
      name: 'Majuli',
      district: 'Jorhat',
      location: { lat: 26.2, lng: 92.9 },
      demographics: unwrap(demographics({ population: 500, households: 100, affectedFamilies: 40 })),
      at,
    }),
  );

  it('FR-VR-1: villageRegistered carries the registration facts', () => {
    const event = villageRegistered(village, at);
    expect(event.type).toBe('VillageRegistered');
    expect(event.occurredAt).toEqual(at);
    expect(event.payload).toEqual({
      villageId,
      name: 'Majuli',
      district: 'Jorhat',
      location: { lat: 26.2, lng: 92.9 },
      demographics: village.demographics,
    });
  });

  it('FR-VR-2: profileUpdated carries the new damage inventory', () => {
    const event = profileUpdated(village, at);
    expect(event.type).toBe('ProfileUpdated');
    expect(event.payload).toEqual({ villageId, damageInventory: village.damageInventory });
  });

  it('FR-VR-3: severityChanged carries from/to/reason', () => {
    const { record } = unwrap(applySeverityChange(village, 'severe', 'flash flood overnight', at));
    const event = severityChanged(village, record, at);
    expect(event.type).toBe('SeverityChanged');
    expect(event.payload).toEqual({
      villageId,
      from: 'unaffected',
      to: 'severe',
      reason: 'flash flood overnight',
    });
  });
});
