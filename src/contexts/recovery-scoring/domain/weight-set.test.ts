import { describe, expect, it } from 'vitest';
import { SCORE_CATEGORIES } from './score-category.js';
import { equalWeights, weightSet } from './weight-set.js';

describe('WeightSet (FR-RS-1, FR-RS-3)', () => {
  it('FR-RS-1: equalWeights gives each of the 11 categories a 1/11 share summing to 1.0', () => {
    const weights = equalWeights();
    for (const category of SCORE_CATEGORIES) {
      expect(weights[category]).toBeCloseTo(1 / 11, 10);
    }
    const sum = SCORE_CATEGORIES.reduce((total, category) => total + weights[category], 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('FR-RS-1: weightSet accepts a custom weighting that sums to 1.0', () => {
    const custom = Object.fromEntries(SCORE_CATEGORIES.map((c, i) => [c, i === 0 ? 0.2 : 0.08]));
    const result = weightSet(custom);
    expect(result.ok).toBe(true);
  });

  it('FR-RS-3: weightSet rejects a set missing one of the 11 categories with WEIGHTS_INVALID', () => {
    const { infrastructure: _infrastructure, ...incomplete } = equalWeights();
    const result = weightSet(incomplete);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WEIGHTS_INVALID');
  });

  it('FR-RS-3: weightSet rejects weights that do not sum to 1.0 beyond epsilon 1e-6', () => {
    const skewed = Object.fromEntries(SCORE_CATEGORIES.map((c) => [c, 0.1]));
    const result = weightSet(skewed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WEIGHTS_INVALID');
  });

  it('FR-RS-3: weightSet accepts a sum within epsilon 1e-6 of 1.0', () => {
    const barelyOff = Object.fromEntries(
      SCORE_CATEGORIES.map((c, i) => [c, i === 0 ? 1 / 11 + 1e-7 : 1 / 11]),
    );
    const result = weightSet(barelyOff);
    expect(result.ok).toBe(true);
  });
});
