import { describe, expect, it } from 'vitest';
import { demographics } from './demographics.js';

// Pure value object: state-based tests are appropriate here (ADR-004 §5).
describe('Demographics', () => {
  it('FR-VR-1: accepts valid demographics where affectedFamilies <= households', () => {
    const result = demographics({ population: 500, households: 100, affectedFamilies: 40 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ population: 500, households: 100, affectedFamilies: 40 });
    }
  });

  it('FR-VR-1: allows affectedFamilies equal to households', () => {
    const result = demographics({ population: 500, households: 100, affectedFamilies: 100 });
    expect(result.ok).toBe(true);
  });

  it('FR-VR-1: rejects affectedFamilies greater than households', () => {
    const result = demographics({ population: 500, households: 100, affectedFamilies: 101 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DEMOGRAPHICS_AFFECTED_EXCEEDS_HOUSEHOLDS');
  });

  it('FR-VR-1: rejects a negative population', () => {
    const result = demographics({ population: -1, households: 10, affectedFamilies: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DEMOGRAPHICS_POPULATION_INVALID');
  });

  it('FR-VR-1: rejects a negative households count', () => {
    const result = demographics({ population: 10, households: -1, affectedFamilies: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DEMOGRAPHICS_HOUSEHOLDS_INVALID');
  });

  it('FR-VR-1: rejects a negative affectedFamilies count', () => {
    const result = demographics({ population: 10, households: 5, affectedFamilies: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DEMOGRAPHICS_AFFECTED_FAMILIES_INVALID');
  });

  it('FR-VR-1: rejects non-integer counts', () => {
    const result = demographics({ population: 10.5, households: 5, affectedFamilies: 0 });
    expect(result.ok).toBe(false);
  });
});
