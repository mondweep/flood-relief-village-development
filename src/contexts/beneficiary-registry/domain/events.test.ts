import { describe, expect, it } from 'vitest';
import { asId, unwrap } from '../../../shared/index.js';
import { aidEvent } from './aid-event.js';
import { aidRecorded, beneficiaryRegistered, duplicateAidSuspected, followUpCompleted } from './events.js';

const beneficiaryId = asId<'BeneficiaryId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b');
const villageId = asId<'VillageId'>('4a9f0b2d-3c5e-4f70-9b1c-2d3e4f5a6b7c');

// Pure event factories: state-based tests (ADR-004 §5).
describe('Beneficiary Registry domain events', () => {
  it('FR-BR-1: beneficiaryRegistered carries id, village and categories', () => {
    const occurredAt = new Date('2026-07-28T00:00:00Z');
    const event = beneficiaryRegistered(beneficiaryId, villageId, ['widow'], occurredAt);

    expect(event.type).toBe('BeneficiaryRegistered');
    expect(event.occurredAt).toEqual(occurredAt);
    expect(event.payload).toEqual({ beneficiaryId, villageId, categories: ['widow'] });
  });

  it('FR-BR-2: aidRecorded carries the beneficiary id and the aid event', () => {
    const at = new Date('2026-07-28T00:00:00Z');
    const aid = unwrap(aidEvent('food', 'Red Cross', at));
    const event = aidRecorded(beneficiaryId, aid, at);

    expect(event.type).toBe('AidRecorded');
    expect(event.payload).toEqual({ beneficiaryId, aid });
  });

  it('FR-BR-3: duplicateAidSuspected carries both event references', () => {
    const first = unwrap(aidEvent('food', 'Red Cross', new Date('2026-07-01T00:00:00Z')));
    const second = unwrap(aidEvent('food', 'Other NGO', new Date('2026-07-03T00:00:00Z')));
    const event = duplicateAidSuspected(beneficiaryId, second, first, second.at);

    expect(event.type).toBe('DuplicateAidSuspected');
    expect(event.payload).toEqual({ beneficiaryId, newAid: second, existingAid: first });
  });

  it('FR-BR-4: followUpCompleted carries the next follow-up date when scheduled', () => {
    const completedAt = new Date('2026-07-28T00:00:00Z');
    const nextFollowUpAt = new Date('2026-08-27T00:00:00Z');
    const event = followUpCompleted(beneficiaryId, completedAt, nextFollowUpAt);

    expect(event.type).toBe('FollowUpCompleted');
    expect(event.payload).toEqual({ beneficiaryId, completedAt, nextFollowUpAt });
  });

  it('FR-BR-4: followUpCompleted omits nextFollowUpAt when none is scheduled', () => {
    const completedAt = new Date('2026-07-28T00:00:00Z');
    const event = followUpCompleted(beneficiaryId, completedAt, undefined);

    expect(event.payload).toEqual({ beneficiaryId, completedAt });
    expect('nextFollowUpAt' in event.payload).toBe(false);
  });
});
