import { type Result, ok, err } from '../../../shared/index.js';
import { SCORE_CATEGORIES, type ScoreCategory } from './score-category.js';

/** FR-RS-1: weights per category; must cover all 11 and sum to 1.0 within epsilon. */
export type WeightSet = Readonly<Record<ScoreCategory, number>>;

const EPSILON = 1e-6;

/** FR-RS-1: default weighting — equal share across all 11 categories. */
export function equalWeights(): WeightSet {
  const equal = 1 / SCORE_CATEGORIES.length;
  return Object.fromEntries(SCORE_CATEGORIES.map((category) => [category, equal])) as WeightSet;
}

/** FR-RS-3: build and validate a custom WeightSet — all 11 categories present, sum to 1.0 ± epsilon. */
export function weightSet(weights: Readonly<Partial<Record<ScoreCategory, number>>>): Result<WeightSet> {
  const missing = SCORE_CATEGORIES.filter((category) => weights[category] === undefined);
  if (missing.length > 0) {
    return err('WEIGHTS_INVALID', `missing weights for categories: ${missing.join(', ')}`);
  }

  const complete = weights as Record<ScoreCategory, number>;
  const sum = SCORE_CATEGORIES.reduce((total, category) => total + complete[category], 0);
  if (Math.abs(sum - 1) > EPSILON) {
    return err('WEIGHTS_INVALID', `weights must sum to 1.0 (within ${EPSILON}), got ${sum}`);
  }

  return ok(Object.fromEntries(SCORE_CATEGORIES.map((category) => [category, complete[category]])) as WeightSet);
}
