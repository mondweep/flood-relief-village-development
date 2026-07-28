import { describe, expect, it } from 'vitest';
import { asId } from '../../../../shared/index.js';
import { toVillageIds } from './affected-village-lookup.js';

describe('toVillageIds', () => {
  it('maps id rows to branded VillageIds', () => {
    const rows = [{ id: '20000000-0000-4000-8000-000000000001' }, { id: '20000000-0000-4000-8000-000000000002' }];
    expect(toVillageIds(rows)).toEqual([
      asId<'VillageId'>('20000000-0000-4000-8000-000000000001'),
      asId<'VillageId'>('20000000-0000-4000-8000-000000000002'),
    ]);
  });

  it('maps an empty result set to an empty array', () => {
    expect(toVillageIds([])).toEqual([]);
  });
});
