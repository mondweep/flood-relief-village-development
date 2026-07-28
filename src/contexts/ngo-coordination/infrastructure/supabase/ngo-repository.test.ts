import { describe, expect, it } from 'vitest';
import { asId, type NgoId } from '../../../../shared/index.js';
import type { Ngo } from '../../domain/ngo.js';
import { fromNgoRow, toNgoRow, type NgoRow } from './ngo-repository.js';

const ngoId = (): NgoId => asId<'NgoId'>('10000000-0000-4000-8000-000000000001');

describe('toNgoRow / fromNgoRow', () => {
  it('round-trips an Ngo through its row shape', () => {
    const ngo: Ngo = { id: ngoId(), name: 'Assam Relief Trust', capacity: 3, verified: true };
    const row: NgoRow = toNgoRow(ngo);

    expect(row).toEqual({ id: ngoId(), name: 'Assam Relief Trust', verified: true, capacity: 3 });
    expect(fromNgoRow(row)).toEqual(ngo);
  });

  it('preserves an unverified NGO', () => {
    const ngo: Ngo = { id: ngoId(), name: 'New NGO', capacity: 1, verified: false };
    expect(fromNgoRow(toNgoRow(ngo))).toEqual(ngo);
  });
});
