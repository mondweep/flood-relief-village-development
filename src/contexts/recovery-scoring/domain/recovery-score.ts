import { type Result, ok, err } from '../../../shared/index.js';
import { SCORE_CATEGORIES, type ScoreCategory, isScoreCategory } from './score-category.js';
import { type CategoryScore, type CategoryScoreInput } from './category-score.js';
import { type WeightSet, equalWeights, weightSet as buildWeightSet } from './weight-set.js';

/** FR-RS-1: the weighted composite recovery score, plus the inputs that produced it. */
export interface RecoveryScore {
  readonly composite: number;
  readonly categoryScores: readonly CategoryScore[];
  readonly weights: WeightSet;
}

/**
 * FR-RS-1 / FR-RS-3: validate a raw set of category-score inputs (and optional weights),
 * then compute the composite = sum(weight_i * category_i), rounded to the nearest integer.
 *
 * Rejects with:
 *  - CATEGORIES_INCOMPLETE — a category is missing, duplicated, or unknown.
 *  - SCORE_OUT_OF_RANGE — any category value falls outside 0-100.
 *  - WEIGHTS_INVALID — supplied weights don't cover all 11 categories or don't sum to 1.0 (±1e-6).
 */
export function calculateRecoveryScore(
  inputs: readonly CategoryScoreInput[],
  weights?: Readonly<Partial<Record<ScoreCategory, number>>>,
): Result<RecoveryScore> {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!isScoreCategory(input.category)) {
      return err('CATEGORIES_INCOMPLETE', `unknown score category: ${input.category}`);
    }
    if (seen.has(input.category)) {
      return err('CATEGORIES_INCOMPLETE', `duplicate score category: ${input.category}`);
    }
    seen.add(input.category);
  }

  const missing = SCORE_CATEGORIES.filter((category) => !seen.has(category));
  if (missing.length > 0) {
    return err('CATEGORIES_INCOMPLETE', `missing score categories: ${missing.join(', ')}`);
  }

  const validatedScores: CategoryScore[] = [];
  for (const input of inputs) {
    if (!Number.isFinite(input.value) || input.value < 0 || input.value > 100) {
      return err('SCORE_OUT_OF_RANGE', `category "${input.category}" score out of range 0-100: ${input.value}`);
    }
    validatedScores.push({ category: input.category as ScoreCategory, value: input.value });
  }

  const weightsResult = weights === undefined ? ok(equalWeights()) : buildWeightSet(weights);
  if (!weightsResult.ok) return weightsResult;
  const resolvedWeights = weightsResult.value;

  const rawComposite = validatedScores.reduce(
    (total, score) => total + resolvedWeights[score.category] * score.value,
    0,
  );
  const composite = Math.min(100, Math.max(0, Math.round(rawComposite)));

  return ok({ composite, categoryScores: validatedScores, weights: resolvedWeights });
}
