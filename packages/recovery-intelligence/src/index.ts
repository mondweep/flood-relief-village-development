export {
  DIMENSIONS,
  isDimension,
  zeroScores,
  type Dimension,
  type DimensionScores,
} from "./domain/dimensions.js";

export { Weights } from "./domain/weights.js";

export {
  RecoveryIndex,
  type RecoveryIndexRestoreProps,
  type ScoreHistoryEntry,
} from "./domain/recovery-index.js";

export {
  isSeverity,
  recommendActions,
  type Recommendation,
  type RecommendationType,
  type Severity,
  type VillageSituation,
} from "./domain/recommendation-policy.js";

export type { RecoveryIndexRepository, WeightsProvider } from "./application/ports.js";

export {
  UpsertDimensionScores,
  type UpsertDimensionScoresDeps,
  type UpsertDimensionScoresInput,
  type UpsertDimensionScoresOutput,
} from "./application/upsert-dimension-scores.js";

export {
  GetRecoveryIndex,
  type GetRecoveryIndexDeps,
  type GetRecoveryIndexInput,
  type RecoveryIndexSnapshot,
} from "./application/get-recovery-index.js";

export {
  GetScoreHistory,
  type GetScoreHistoryDeps,
  type GetScoreHistoryInput,
  type GetScoreHistoryOutput,
} from "./application/get-score-history.js";

export { RecommendActions, type RecommendActionsInput } from "./application/recommend-actions.js";

export {
  DAMAGE_ASSESSED_EVENT,
  makeDamageAssessedHandler,
  type ScoreRecalculator,
} from "./application/damage-assessed-handler.js";

export { InMemoryRecoveryIndexRepository } from "./adapters/in-memory-recovery-index-repository.js";
export { StaticWeightsProvider } from "./adapters/static-weights-provider.js";

export {
  HISTORY_TABLE,
  INDICES_TABLE,
  SupabaseRecoveryIndexRepository,
  fromRow as recoveryIndexFromRow,
  toHistoryRows,
  toRow as recoveryIndexToRow,
  type RecoveryIndexRow,
  type ScoreHistoryRow,
} from "./adapters/supabase-recovery-index-repository.js";
