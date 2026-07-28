import { describe, expect, it } from 'vitest';
import { asId, unwrap } from '../../../shared/index.js';
import { aidEvent } from './aid-event.js';
import { Beneficiary } from './beneficiary.js';

const id = asId<'BeneficiaryId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b');
const villageId = asId<'VillageId'>('4a9f0b2d-3c5e-4f70-9b1c-2d3e4f5a6b7c');

// Pure aggregate logic: state-based tests (ADR-004 §5).
describe('Beneficiary aggregate', () => {
  describe('register', () => {
    it('FR-BR-1: registers with at least one category and a village', () => {
      const registeredAt = new Date('2026-07-28T00:00:00Z');
      const beneficiary = unwrap(
        Beneficiary.register({ id, villageId, categories: ['farmer'], registeredAt }),
      );

      expect(beneficiary.id).toBe(id);
      expect(beneficiary.villageId).toBe(villageId);
      expect(beneficiary.categories).toEqual(['farmer']);
      expect(beneficiary.aidHistory).toEqual([]);
      expect(beneficiary.registeredAt).toEqual(registeredAt);
    });

    it('FR-BR-1: rejects registration with zero vulnerability categories', () => {
      const result = Beneficiary.register({ id, villageId, categories: [], registeredAt: new Date() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('BENEFICIARY_NO_CATEGORY');
    });

    it('FR-BR-4: widow and orphaned_child are registered with a next follow-up already scheduled', () => {
      const registeredAt = new Date('2026-07-28T00:00:00Z');
      const widow = unwrap(Beneficiary.register({ id, villageId, categories: ['widow'], registeredAt }));
      expect(widow.nextFollowUpAt).toBeInstanceOf(Date);
    });

    it('FR-BR-4: other categories are registered with no follow-up scheduled', () => {
      const farmer = unwrap(
        Beneficiary.register({ id, villageId, categories: ['farmer'], registeredAt: new Date() }),
      );
      expect(farmer.nextFollowUpAt).toBeUndefined();
    });
  });

  describe('recordAid', () => {
    function registered() {
      return unwrap(
        Beneficiary.register({
          id,
          villageId,
          categories: ['farmer'],
          registeredAt: new Date('2026-07-01T00:00:00Z'),
        }),
      );
    }

    it('FR-BR-2: appends aid events, leaving history append-only', () => {
      const beneficiary = registered();
      const first = unwrap(aidEvent('food', 'Red Cross', new Date('2026-07-01T00:00:00Z')));

      const { beneficiary: updated } = beneficiary.recordAid(first);

      expect(updated.aidHistory).toEqual([first]);
      // the original instance is untouched
      expect(beneficiary.aidHistory).toEqual([]);
    });

    it('FR-BR-3: same kind within the suspicion window flags a duplicate but keeps the record', () => {
      const beneficiary = registered();
      const first = unwrap(aidEvent('food', 'Red Cross', new Date('2026-07-01T00:00:00Z')));
      const { beneficiary: afterFirst } = beneficiary.recordAid(first);

      const second = unwrap(aidEvent('food', 'Other NGO', new Date('2026-07-05T00:00:00Z')));
      const { beneficiary: afterSecond, duplicateOf } = afterFirst.recordAid(second);

      expect(afterSecond.aidHistory).toEqual([first, second]);
      expect(duplicateOf).toEqual(first);
    });

    it('FR-BR-3: different kind within the window is not flagged', () => {
      const beneficiary = registered();
      const first = unwrap(aidEvent('food', 'Red Cross', new Date('2026-07-01T00:00:00Z')));
      const { beneficiary: afterFirst } = beneficiary.recordAid(first);

      const second = unwrap(aidEvent('medical', 'Red Cross', new Date('2026-07-02T00:00:00Z')));
      const { duplicateOf } = afterFirst.recordAid(second);

      expect(duplicateOf).toBeUndefined();
    });

    it('FR-BR-3: same kind outside the window is not flagged', () => {
      const beneficiary = registered();
      const first = unwrap(aidEvent('food', 'Red Cross', new Date('2026-07-01T00:00:00Z')));
      const { beneficiary: afterFirst } = beneficiary.recordAid(first);

      const second = unwrap(aidEvent('food', 'Other NGO', new Date('2026-07-09T00:00:00Z')));
      const { duplicateOf } = afterFirst.recordAid(second);

      expect(duplicateOf).toBeUndefined();
    });
  });

  describe('completeFollowUp / isFollowUpOverdue', () => {
    it('FR-BR-4: completing a follow-up reschedules the next one for mandatory categories', () => {
      const widow = unwrap(
        Beneficiary.register({
          id,
          villageId,
          categories: ['widow'],
          registeredAt: new Date('2026-07-01T00:00:00Z'),
        }),
      );

      const completedAt = new Date('2026-07-28T00:00:00Z');
      const updated = widow.completeFollowUp(completedAt, 30);

      expect(updated.nextFollowUpAt).toEqual(new Date('2026-08-27T00:00:00Z'));
    });

    it('FR-BR-4: completing a follow-up for a non-mandatory category leaves it unscheduled', () => {
      const farmer = unwrap(
        Beneficiary.register({ id, villageId, categories: ['farmer'], registeredAt: new Date() }),
      );

      const updated = farmer.completeFollowUp(new Date());
      expect(updated.nextFollowUpAt).toBeUndefined();
    });

    it('FR-BR-4: a beneficiary is overdue once now passes nextFollowUpAt', () => {
      const widow = unwrap(
        Beneficiary.register({
          id,
          villageId,
          categories: ['widow'],
          registeredAt: new Date('2026-07-01T00:00:00Z'),
        }),
      ).completeFollowUp(new Date('2026-07-01T00:00:00Z'), 7);

      expect(widow.isFollowUpOverdue(new Date('2026-07-09T00:00:00Z'))).toBe(true);
      expect(widow.isFollowUpOverdue(new Date('2026-07-05T00:00:00Z'))).toBe(false);
    });
  });
});
