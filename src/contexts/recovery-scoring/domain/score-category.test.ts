import { describe, expect, it } from 'vitest';
import { SCORE_CATEGORIES, isScoreCategory } from './score-category.js';

describe('ScoreCategory (FR-RS-1, FR-RS-3)', () => {
  it('FR-RS-1: defines exactly the 11 required categories', () => {
    expect(SCORE_CATEGORIES).toHaveLength(11);
    expect(SCORE_CATEGORIES).toEqual([
      'infrastructure',
      'education',
      'health',
      'livelihood',
      'agriculture',
      'housing',
      'employment',
      'water',
      'sanitation',
      'road',
      'electricity',
    ]);
  });

  it('FR-RS-3: isScoreCategory recognizes valid categories and rejects unknown strings', () => {
    expect(isScoreCategory('health')).toBe(true);
    expect(isScoreCategory('sanitation')).toBe(true);
    expect(isScoreCategory('flooding')).toBe(false);
    expect(isScoreCategory('')).toBe(false);
  });
});
