import { describe, expect, it } from 'vitest';
import { asId } from '../../../../shared/index.js';
import { toActiveNgoId } from './assignment-lookup.js';

describe('toActiveNgoId', () => {
  it('maps a found row to its NgoId', () => {
    expect(toActiveNgoId({ ngo_id: '10000000-0000-4000-8000-000000000001' })).toEqual(
      asId<'NgoId'>('10000000-0000-4000-8000-000000000001'),
    );
  });

  it('maps no row to null', () => {
    expect(toActiveNgoId(null)).toBeNull();
  });
});
