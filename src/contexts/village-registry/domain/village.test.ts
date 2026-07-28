import { describe, expect, it } from 'vitest';
import { asId, unwrap, type VillageId } from '../../../shared/index.js';
import { createVillage, applyDamageInventory, applySeverityChange } from './village.js';
import { demographics } from './demographics.js';
import { damageInventory } from './damage-inventory.js';

// Pure aggregate methods: state-based tests are appropriate here (ADR-004 §5).
describe('Village aggregate', () => {
  const villageId = asId<'VillageId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as VillageId;
  const registeredAt = new Date('2026-07-28T08:00:00.000Z');
  const location = { lat: 26.2, lng: 92.9 };
  const validDemographics = unwrap(demographics({ population: 500, households: 100, affectedFamilies: 40 }));

  describe('createVillage', () => {
    it('FR-VR-1: registers a village with a zero damage inventory and unaffected severity', () => {
      const result = createVillage({
        id: villageId,
        name: 'Majuli',
        district: 'Jorhat',
        location,
        demographics: validDemographics,
        at: registeredAt,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({
          id: villageId,
          name: 'Majuli',
          district: 'Jorhat',
          location,
          demographics: validDemographics,
          severity: 'unaffected',
          severityHistory: [],
          registeredAt,
          updatedAt: registeredAt,
        });
        expect(result.value.damageInventory).toEqual({
          houses: 0,
          schools: 0,
          healthCentres: 0,
          waterSources: 0,
          agricultureHectares: 0,
          livestock: 0,
        });
      }
    });

    it('FR-VR-1: rejects registration with an empty name', () => {
      const result = createVillage({
        id: villageId,
        name: '   ',
        district: 'Jorhat',
        location,
        demographics: validDemographics,
        at: registeredAt,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VILLAGE_NAME_REQUIRED');
    });

    it('FR-VR-1: rejects registration with an empty district', () => {
      const result = createVillage({
        id: villageId,
        name: 'Majuli',
        district: '',
        location,
        demographics: validDemographics,
        at: registeredAt,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VILLAGE_DISTRICT_REQUIRED');
    });
  });

  describe('applyDamageInventory', () => {
    it('FR-VR-2: replaces the damage inventory and bumps updatedAt', () => {
      const village = unwrap(
        createVillage({
          id: villageId,
          name: 'Majuli',
          district: 'Jorhat',
          location,
          demographics: validDemographics,
          at: registeredAt,
        }),
      );
      const inventory = unwrap(
        damageInventory({
          houses: 30,
          schools: 2,
          healthCentres: 1,
          waterSources: 4,
          agricultureHectares: 120.5,
          livestock: 60,
        }),
      );
      const updatedAt = new Date('2026-07-29T09:00:00.000Z');

      const updated = applyDamageInventory(village, inventory, updatedAt);

      expect(updated.damageInventory).toEqual(inventory);
      expect(updated.updatedAt).toEqual(updatedAt);
      expect(updated.registeredAt).toEqual(registeredAt);
    });
  });

  describe('applySeverityChange', () => {
    it('FR-VR-3: transitions severity and appends an audit record with reason', () => {
      const village = unwrap(
        createVillage({
          id: villageId,
          name: 'Majuli',
          district: 'Jorhat',
          location,
          demographics: validDemographics,
          at: registeredAt,
        }),
      );
      const changedAt = new Date('2026-07-29T09:00:00.000Z');

      const result = applySeverityChange(village, 'severe', 'flash flood overnight', changedAt);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.village.severity).toBe('severe');
        expect(result.value.village.severityHistory).toEqual([
          { from: 'unaffected', to: 'severe', reason: 'flash flood overnight', at: changedAt },
        ]);
        expect(result.value.record).toEqual({
          from: 'unaffected',
          to: 'severe',
          reason: 'flash flood overnight',
          at: changedAt,
        });
      }
    });

    it('FR-VR-3: accumulates history across multiple transitions', () => {
      const village = unwrap(
        createVillage({
          id: villageId,
          name: 'Majuli',
          district: 'Jorhat',
          location,
          demographics: validDemographics,
          at: registeredAt,
        }),
      );
      const first = unwrap(applySeverityChange(village, 'low', 'initial assessment', registeredAt)).village;
      const secondAt = new Date('2026-07-30T09:00:00.000Z');
      const second = unwrap(applySeverityChange(first, 'critical', 'levee breach', secondAt)).village;

      expect(second.severityHistory).toHaveLength(2);
      expect(second.severityHistory[1]).toEqual({
        from: 'low',
        to: 'critical',
        reason: 'levee breach',
        at: secondAt,
      });
    });

    it('FR-VR-3: rejects severity change without reason', () => {
      const village = unwrap(
        createVillage({
          id: villageId,
          name: 'Majuli',
          district: 'Jorhat',
          location,
          demographics: validDemographics,
          at: registeredAt,
        }),
      );
      const result = applySeverityChange(village, 'severe', '', registeredAt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SEVERITY_REASON_REQUIRED');
    });
  });
});
