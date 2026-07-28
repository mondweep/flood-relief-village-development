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

/** State needed to rebuild a RecoveryIndex from storage — see RecoveryIndex.restore. */
export interface RecoveryIndexRestoreProps {
  villageId: VillageId;
  scores: DimensionScores;
  composite: number;
  calculatedAt: string | null;
  history: readonly ScoreHistoryEntry[];
}

function validateFullScores(scores: DimensionScores): string | null {
  for (const key of Object.keys(scores)) {
    if (!isDimension(key)) return `unknown dimension: ${key}`;
  }
  for (const dimension of DIMENSIONS) {
    const value = (scores as Partial<DimensionScores>)[dimension];
    if (value === undefined) return `missing score for dimension: ${dimension}`;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return `score for ${dimension} must be a number between 0 and 100`;
    }
  }
  return null;
}

function validateComposite(composite: number, field: string): string | null {
  if (!Number.isInteger(composite) || composite < 0 || composite > 100) {
    return `${field} must be an integer between 0 and 100`;
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

  /**
   * Rebuilds a RecoveryIndex from persisted state. Intended for repository
   * adapters only — application code goes through create() + upsertScores().
   *
   * The history is append-only and each entry's composite was derived from the
   * weights in force at the time, so replaying upsertScores() with today's
   * weights would silently rewrite history. restore() takes the stored entries
   * verbatim while re-checking every range invariant upsertScores() enforces.
   */
  static restore(props: RecoveryIndexRestoreProps): Result<RecoveryIndex> {
    const scoresError = validateFullScores(props.scores);
    if (scoresError) return err(scoresError);

    const compositeError = validateComposite(props.composite, "composite");
    if (compositeError) return err(compositeError);

    if (props.calculatedAt !== null && props.calculatedAt.trim().length === 0) {
      return err("calculatedAt must not be empty");
    }
    if (props.calculatedAt === null && props.history.length > 0) {
      return err("an index with history must have a calculatedAt");
    }

    const index = new RecoveryIndex(props.villageId);
    for (const entry of props.history) {
      const entryError = validateComposite(entry.composite, "history composite");
      if (entryError) return err(entryError);
      if (entry.calculatedAt.trim().length === 0) {
        return err("history calculatedAt must not be empty");
      }
      index._history.push({ composite: entry.composite, calculatedAt: entry.calculatedAt });
    }

    index._scores = { ...props.scores };
    index._composite = props.composite;
    index._calculatedAt = props.calculatedAt;
    return ok(index);
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

    // Strip keys present with an undefined value so they cannot clobber existing scores.
    const updates: Partial<Record<Dimension, number>> = {};
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) updates[key as Dimension] = value;
    }

    const nextScores = { ...this._scores, ...updates };
    let weighted = 0;
    for (const dimension of DIMENSIONS) {
      weighted += weights.get(dimension) * nextScores[dimension];
    }
    const composite = Math.round(weighted);
    if (!Number.isFinite(composite)) {
      return err("composite must be a finite number");
    }

    this._scores = nextScores;
    this._composite = composite;
    this._calculatedAt = calculatedAt;
    this._history.push({ composite: this._composite, calculatedAt });

    return ok({ composite: this._composite });
  }
}
