import { describe, expect, it } from 'vitest';
import { asId } from '../../../../shared/index.js';
import { toComparableProject } from './comparable-projects-query.js';

describe('toComparableProject', () => {
  it('maps a funded_projects row to the ComparableProject shape', () => {
    const row = { id: '50000000-0000-4000-8000-000000000001', category: 'road', spent_minor: 250000, currency: 'INR' };
    expect(toComparableProject(row)).toEqual({
      projectId: asId<'ProjectId'>('50000000-0000-4000-8000-000000000001'),
      category: 'road',
      spent: { amountMinor: 250000, currency: 'INR' },
    });
  });
});
