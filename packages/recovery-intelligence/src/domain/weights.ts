import { err, ok, type Result } from "@afrip/shared-kernel";
import { DIMENSIONS, isDimension, type Dimension, type DimensionScores } from "./dimensions.js";

const SUM_TOLERANCE = 1e-9;

/** Value object: per-dimension weights for the composite score, summing to 1. */
export class Weights {
  private constructor(private readonly values: DimensionScores) {}

  static of(values: Record<Dimension, number>): Result<Weights> {
    for (const key of Object.keys(values)) {
      if (!isDimension(key)) return err(`unknown dimension: ${key}`);
    }
    const normalized = {} as DimensionScores;
    let sum = 0;
    for (const dimension of DIMENSIONS) {
      const weight = (values as Partial<DimensionScores>)[dimension];
      if (weight === undefined) return err(`missing weight for dimension: ${dimension}`);
      if (!Number.isFinite(weight)) return err(`weight for ${dimension} must be a finite number`);
      if (weight < 0) return err(`weight for ${dimension} must not be negative`);
      normalized[dimension] = weight;
      sum += weight;
    }
    if (Math.abs(sum - 1) > SUM_TOLERANCE) {
      return err(`weights must sum to 1 (got ${sum})`);
    }
    return ok(new Weights(normalized));
  }

  /** Default: equal weight (1/11) for every dimension. */
  static equal(): Weights {
    const values = {} as DimensionScores;
    for (const dimension of DIMENSIONS) values[dimension] = 1 / DIMENSIONS.length;
    return new Weights(values);
  }

  get(dimension: Dimension): number {
    return this.values[dimension];
  }

  toRecord(): DimensionScores {
    return { ...this.values };
  }
}
