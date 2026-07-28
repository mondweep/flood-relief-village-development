import { type Result, ok, err } from '../../../shared/index.js';
import { type ScoreCategory, isScoreCategory } from './score-category.js';

/** FR-RS-1 / FR-RS-3: a single category's score, bounded 0-100. Pure value object. */
export interface CategoryScore {
  readonly category: ScoreCategory;
  readonly value: number;
}

/** Raw, unvalidated input shape as it arrives at the boundary (e.g. from a use-case caller). */
export interface CategoryScoreInput {
  readonly category: string;
  readonly value: number;
}

export function categoryScore(category: string, value: number): Result<CategoryScore> {
  if (!isScoreCategory(category)) {
    return err('CATEGORIES_INCOMPLETE', `unknown score category: ${category}`);
  }
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return err('SCORE_OUT_OF_RANGE', `category "${category}" score out of range 0-100: ${value}`);
  }
  return ok({ category, value });
}
