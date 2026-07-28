import { describe, expect, it } from 'vitest';
import { SCORE_CATEGORIES } from './score-category.js';
import { calculateRecoveryScore } from './recovery-score.js';

const fullSet = (value: number | ((category: string, index: number) => number)) =>
  SCORE_CATEGORIES.map((category, index) => ({
    category,
    value: typeof value === 'function' ? value(category, index) : value,
  }));

describe('calculateRecoveryScore (FR-RS-1, FR-RS-3)', () => {
  it('FR-RS-1: computes the composite as the weighted sum of category scores, rounded', () => {
    const result = calculateRecoveryScore(fullSet(80));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(80);
  });

  it('FR-RS-1: defaults to equal weights (1/11 each) when none are supplied', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 0];
    const inputs = SCORE_CATEGORIES.map((category, i) => ({ category, value: values[i]! }));
    const result = calculateRecoveryScore(inputs);
    expect(result.ok).toBe(true);
    // average of the values above is 50
    if (result.ok) expect(result.value.composite).toBe(50);
  });

  it('FR-RS-1: honors a custom WeightSet', () => {
    const weights = Object.fromEntries(SCORE_CATEGORIES.map((c) => [c, c === 'health' ? 1 : 0]));
    const inputs = fullSet((category) => (category === 'health' ? 90 : 10));
    const result = calculateRecoveryScore(inputs, weights);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(90);
  });

  it('FR-RS-1: rounds to the nearest integer', () => {
    // average of 33 and 34s -> fractional composite must round
    const values = [33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 34]; // sum 364 -> 33.09..
    const inputs = SCORE_CATEGORIES.map((category, i) => ({ category, value: values[i]! }));
    const result = calculateRecoveryScore(inputs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(33);
  });

  it('sanity fixture: a plausible category breakdown yields the concept document village index of 42', () => {
    const values = [35, 50, 60, 30, 45, 25, 40, 55, 38, 44, 40];
    const inputs = SCORE_CATEGORIES.map((category, i) => ({ category, value: values[i]! }));
    const result = calculateRecoveryScore(inputs);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(42);
  });

  it('FR-RS-3: rejects a missing category with CATEGORIES_INCOMPLETE', () => {
    const inputs = fullSet(50).filter((entry) => entry.category !== 'electricity');
    const result = calculateRecoveryScore(inputs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CATEGORIES_INCOMPLETE');
  });

  it('FR-RS-3: rejects a duplicated category with CATEGORIES_INCOMPLETE', () => {
    const inputs = [...fullSet(50).filter((entry) => entry.category !== 'electricity'), { category: 'health', value: 50 }];
    const result = calculateRecoveryScore(inputs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CATEGORIES_INCOMPLETE');
  });

  it('FR-RS-3: rejects an unknown category with CATEGORIES_INCOMPLETE', () => {
    const inputs = [...fullSet(50).filter((entry) => entry.category !== 'electricity'), { category: 'flooding', value: 50 }];
    const result = calculateRecoveryScore(inputs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CATEGORIES_INCOMPLETE');
  });

  it('FR-RS-3: rejects any category value outside 0-100 with SCORE_OUT_OF_RANGE', () => {
    const inputs = fullSet((category) => (category === 'road' ? 150 : 50));
    const result = calculateRecoveryScore(inputs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SCORE_OUT_OF_RANGE');
  });

  it('FR-RS-3: rejects weights that do not sum to 1.0 within epsilon 1e-6 with WEIGHTS_INVALID', () => {
    const weights = Object.fromEntries(SCORE_CATEGORIES.map((c) => [c, 0.2]));
    const result = calculateRecoveryScore(fullSet(50), weights);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WEIGHTS_INVALID');
  });

  it('FR-RS-3: rejects weights missing a category with WEIGHTS_INVALID', () => {
    const weights = Object.fromEntries(SCORE_CATEGORIES.filter((c) => c !== 'road').map((c) => [c, 1 / 10]));
    const result = calculateRecoveryScore(fullSet(50), weights);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WEIGHTS_INVALID');
  });
});
