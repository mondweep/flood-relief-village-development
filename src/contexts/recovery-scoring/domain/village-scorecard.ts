import type { VillageId } from '../../../shared/index.js';
import type { RecoveryScore } from './recovery-score.js';

/** FR-RS-2: one append-only entry in a village's score history. */
export interface ScoreHistoryEntry {
  readonly score: RecoveryScore;
  readonly recordedAt: Date;
}

/** Aggregate root: a village's Recovery Score history (PRD §5 BC-5). Append-only. */
export interface VillageScorecard {
  readonly villageId: VillageId;
  readonly history: readonly ScoreHistoryEntry[];
}

export type TrendDirection = 'improving' | 'declining' | 'stable';

export interface ScoreTrend {
  readonly direction: TrendDirection;
  readonly delta: number;
}

export function createScorecard(villageId: VillageId): VillageScorecard {
  return { villageId, history: [] };
}

/** FR-RS-2: history is append-only — always returns a new scorecard with the entry added. */
export function appendScore(
  scorecard: VillageScorecard,
  score: RecoveryScore,
  recordedAt: Date,
): VillageScorecard {
  return { ...scorecard, history: [...scorecard.history, { score, recordedAt }] };
}

/**
 * FR-RS-2: trend = latest minus previous. A single entry (or no entry) is 'stable' with delta 0.
 */
export function scoreTrend(scorecard: VillageScorecard): ScoreTrend {
  const { history } = scorecard;
  if (history.length < 2) return { direction: 'stable', delta: 0 };

  const latest = history[history.length - 1]!.score.composite;
  const previous = history[history.length - 2]!.score.composite;
  const delta = latest - previous;
  const direction: TrendDirection = delta > 0 ? 'improving' : delta < 0 ? 'declining' : 'stable';
  return { direction, delta };
}
