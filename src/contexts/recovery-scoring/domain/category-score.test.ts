import { describe, expect, it } from 'vitest';
import { categoryScore } from './category-score.js';

describe('CategoryScore (FR-RS-1, FR-RS-3)', () => {
  it('FR-RS-1: accepts a valid category with a value in range 0-100', () => {
    const result = categoryScore('health', 80);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ category: 'health', value: 80 });
    }
  });

  it('FR-RS-1: accepts boundary values 0 and 100', () => {
    expect(categoryScore('water', 0).ok).toBe(true);
    expect(categoryScore('water', 100).ok).toBe(true);
  });

  it('FR-RS-3: rejects an unknown category with CATEGORIES_INCOMPLETE', () => {
    const result = categoryScore('flooding', 50);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CATEGORIES_INCOMPLETE');
  });

  it('FR-RS-3: rejects values outside 0-100 with SCORE_OUT_OF_RANGE', () => {
    const tooLow = categoryScore('road', -1);
    const tooHigh = categoryScore('road', 101);
    const notFinite = categoryScore('road', Number.NaN);
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.error.code).toBe('SCORE_OUT_OF_RANGE');
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.error.code).toBe('SCORE_OUT_OF_RANGE');
    expect(notFinite.ok).toBe(false);
    if (!notFinite.ok) expect(notFinite.error.code).toBe('SCORE_OUT_OF_RANGE');
  });
});
