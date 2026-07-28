import { err, ok, type Result, type VillageId } from "@afrip/shared-kernel";
import {
  DIMENSIONS,
  isDimension,
  zeroScores,
  type Dimension,
  type DimensionScores,
} from "./dimensions.js";
import type { Weights } from "./weights.js";

export interface ScoreHistoryEntry {
  readonly composite: number;
  readonly calculatedAt: string;
}

function validatePartialScores(partial: Partial<Record<Dimension, number>>): string | null {
  for (const [key, value] of Object.entries(partial)) {
    if (!isDimension(key)) return `unknown dimension: ${key}`;
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return `score for ${key} must be a number between 0 and 100`;
    }
  }
  return null;
}

/** Aggregate root: a village's recovery health scores and composite index. */
export class RecoveryIndex {
  readonly villageId: VillageId;
  private _scores: DimensionScores;
  private _composite: number;
  private _calculatedAt: string | null;
  private readonly _history: ScoreHistoryEntry[];

  private constructor(villageId: VillageId) {
    this.villageId = villageId;
    this._scores = zeroScores();
    this._composite = 0;
    this._calculatedAt = null;
    this._history = [];
  }

  /** New index for a village: every dimension defaults to 0, no history yet. */
  static create(villageId: VillageId): RecoveryIndex {
    return new RecoveryIndex(villageId);
  }

  get scores(): DimensionScores {
    return { ...this._scores };
  }

  get composite(): number {
    return this._composite;
  }

  get calculatedAt(): string | null {
    return this._calculatedAt;
  }

  get history(): readonly ScoreHistoryEntry[] {
    return this._history;
  }

  /**
   * Merges the partial scores over the existing ones (missing dimensions keep
   * their current value, defaulting to 0), recomputes the composite as the
   * weighted mean rounded to the nearest integer, and appends to the history.
   */
  upsertScores(
    partial: Partial<Record<Dimension, number>>,
    weights: Weights,
    calculatedAt: string,
  ): Result<{ composite: number }> {
    const error = validatePartialScores(partial);
    if (error) return err(error);
    if (calculatedAt.trim().length === 0) return err("calculatedAt must not be empty");

    this._scores = { ...this._scores, ...partial };

    let weighted = 0;
    for (const dimension of DIMENSIONS) {
      weighted += weights.get(dimension) * this._scores[dimension];
    }
    this._composite = Math.round(weighted);
    this._calculatedAt = calculatedAt;
    this._history.push({ composite: this._composite, calculatedAt });

    return ok({ composite: this._composite });
  }
}
