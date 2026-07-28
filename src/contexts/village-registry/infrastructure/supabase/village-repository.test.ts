import { describe, expect, it } from 'vitest';
import { asId, type GeoPoint } from '../../../../shared/index.js';
import type { Village } from '../../domain/village.js';
import {
  fromVillageRow,
  toNewSeverityChangeRow,
  toVillageRow,
  type SeverityChangeRow,
  type VillageRow,
} from './village-repository.js';

const villageId = () => asId<'VillageId'>('20000000-0000-4000-8000-000000000001');

const aVillage = (): Village => ({
  id: villageId(),
  name: 'Majuli',
  district: 'Jorhat',
  location: { lat: 26.95, lng: 94.16 } as GeoPoint,
  demographics: { population: 1000, households: 200, affectedFamilies: 50 },
  damageInventory: {
    houses: 12,
    schools: 1,
    healthCentres: 0,
    waterSources: 3,
    agricultureHectares: 40.5,
    livestock: 7,
  },
  severity: 'moderate',
  severityHistory: [
    { from: 'unaffected', to: 'low', reason: 'initial flooding', at: new Date('2026-07-01T00:00:00.000Z') },
    { from: 'low', to: 'moderate', reason: 'water rising', at: new Date('2026-07-05T00:00:00.000Z') },
  ],
  registeredAt: new Date('2026-06-30T00:00:00.000Z'),
  updatedAt: new Date('2026-07-05T00:00:00.000Z'),
});

describe('toVillageRow', () => {
  it('flattens the aggregate into the villages row shape', () => {
    const row = toVillageRow(aVillage());
    expect(row).toMatchObject({
      id: villageId(),
      name: 'Majuli',
      district: 'Jorhat',
      lat: 26.95,
      lng: 94.16,
      population: 1000,
      households: 200,
      affected_families: 50,
      severity: 'moderate',
      damaged_houses: 12,
      damaged_schools: 1,
      damaged_health_centres: 0,
      damaged_water_sources: 3,
      agriculture_hectares_damaged: 40.5,
      livestock_lost: 7,
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-07-05T00:00:00.000Z',
    });
  });
});

describe('toNewSeverityChangeRow', () => {
  it('maps a single history entry to an insertable row', () => {
    const record = { from: 'low' as const, to: 'moderate' as const, reason: 'water rising', at: new Date('2026-07-05T00:00:00.000Z') };
    expect(toNewSeverityChangeRow(villageId(), record)).toEqual({
      village_id: villageId(),
      from_severity: 'low',
      to_severity: 'moderate',
      reason: 'water rising',
      changed_at: '2026-07-05T00:00:00.000Z',
    });
  });
});

describe('fromVillageRow', () => {
  it('round-trips a row + history back into a Village aggregate', () => {
    const village = aVillage();
    const row: VillageRow = toVillageRow(village);
    const historyRows: SeverityChangeRow[] = village.severityHistory.map((r) => toNewSeverityChangeRow(village.id, r));

    const reconstructed = fromVillageRow(row, historyRows);

    expect(reconstructed).toEqual(village);
  });

  it('produces an empty severity history when there are no history rows', () => {
    const village = aVillage();
    const row = toVillageRow({ ...village, severityHistory: [] });

    const reconstructed = fromVillageRow(row, []);

    expect(reconstructed.severityHistory).toEqual([]);
  });
});
