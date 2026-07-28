import { describe, expect, it } from 'vitest';
import { asId, unwrap, type BeneficiaryId, type VillageId } from '../../../../shared/index.js';
import { Beneficiary } from '../../domain/beneficiary.js';
import { aidEvent } from '../../domain/aid-event.js';
import {
  fromBeneficiaryRow,
  toBeneficiaryRow,
  toNewAidEventRow,
  type AidEventRow,
} from './beneficiary-repository.js';

const beneficiaryId = (): BeneficiaryId => asId<'BeneficiaryId'>('40000000-0000-4000-8000-000000000001');
const villageId = (): VillageId => asId<'VillageId'>('20000000-0000-4000-8000-000000000001');

describe('toBeneficiaryRow', () => {
  it('maps categories and the scheduled follow-up date, and always non-nulls full_name', () => {
    const beneficiary = unwrap(
      Beneficiary.register({
        id: beneficiaryId(),
        villageId: villageId(),
        categories: ['widow'],
        registeredAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );

    const row = toBeneficiaryRow(beneficiary);

    expect(row.id).toBe(beneficiaryId());
    expect(row.village_id).toBe(villageId());
    expect(row.full_name.length).toBeGreaterThan(0);
    expect(row.categories).toEqual(['widow']);
    expect(row.next_follow_up_at).toBe('2026-07-31T00:00:00.000Z');
    expect(row.created_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('leaves next_follow_up_at null for categories with no mandatory follow-up', () => {
    const beneficiary = unwrap(
      Beneficiary.register({
        id: beneficiaryId(),
        villageId: villageId(),
        categories: ['farmer'],
        registeredAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );

    expect(toBeneficiaryRow(beneficiary).next_follow_up_at).toBeNull();
  });
});

describe('toNewAidEventRow', () => {
  it('maps an AidEvent to an insertable row, omitting a null note when absent', () => {
    const aid = unwrap(aidEvent('food_kit', 'Red Cross', new Date('2026-07-10T00:00:00.000Z')));
    const row = toNewAidEventRow(beneficiaryId(), aid);

    expect(row.beneficiary_id).toBe(beneficiaryId());
    expect(row.kind).toBe('food_kit');
    expect(row.provider_name).toBe('Red Cross');
    expect(row.note).toBeNull();
    expect(row.occurred_at).toBe('2026-07-10T00:00:00.000Z');
    expect(typeof row.id).toBe('string');
  });

  it('carries a note through when present', () => {
    const aid = unwrap(aidEvent('food_kit', 'Red Cross', new Date('2026-07-10T00:00:00.000Z'), 'urgent'));
    expect(toNewAidEventRow(beneficiaryId(), aid).note).toBe('urgent');
  });
});

describe('fromBeneficiaryRow', () => {
  it('rebuilds a Beneficiary whose getters reflect the persisted row and aid history', () => {
    const registered = unwrap(
      Beneficiary.register({
        id: beneficiaryId(),
        villageId: villageId(),
        categories: ['widow', 'senior_citizen'],
        registeredAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
    );
    const aid = unwrap(aidEvent('food_kit', 'Red Cross', new Date('2026-07-10T00:00:00.000Z')));
    const { beneficiary: withAid } = registered.recordAid(aid);

    const row = toBeneficiaryRow(withAid);
    const aidRow: AidEventRow = { ...toNewAidEventRow(beneficiaryId(), aid), id: 'aid-row-1' };

    const rebuilt = fromBeneficiaryRow(row, [aidRow]);

    expect(rebuilt.id).toBe(beneficiaryId());
    expect(rebuilt.villageId).toBe(villageId());
    expect(rebuilt.categories).toEqual(['widow', 'senior_citizen']);
    expect(rebuilt.aidHistory).toEqual([aid]);
    expect(rebuilt.nextFollowUpAt).toEqual(withAid.nextFollowUpAt);
    expect(rebuilt.registeredAt).toEqual(new Date('2026-07-01T00:00:00.000Z'));
  });

  it('rebuilds with an empty aid history and no scheduled follow-up when none is persisted', () => {
    const row = toBeneficiaryRow(
      unwrap(
        Beneficiary.register({
          id: beneficiaryId(),
          villageId: villageId(),
          categories: ['farmer'],
          registeredAt: new Date('2026-07-01T00:00:00.000Z'),
        }),
      ),
    );

    const rebuilt = fromBeneficiaryRow(row, []);

    expect(rebuilt.aidHistory).toEqual([]);
    expect(rebuilt.nextFollowUpAt).toBeUndefined();
  });
});
