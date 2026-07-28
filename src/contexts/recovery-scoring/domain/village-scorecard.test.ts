import { describe, expect, it } from 'vitest';
import { asId, type VillageId } from '../../../shared/index.js';
import { appendScore, createScorecard, scoreTrend } from './village-scorecard.js';
import type { RecoveryScore } from './recovery-score.js';
import { equalWeights } from './weight-set.js';

const villageId = asId<'VillageId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as VillageId;

const scoreOf = (composite: number): RecoveryScore => ({
  composite,
  categoryScores: [],
  weights: equalWeights(),
});

describe('VillageScorecard (FR-RS-2)', () => {
  it('FR-RS-2: starts with an empty append-only history', () => {
    const scorecard = createScorecard(villageId);
    expect(scorecard.villageId).toBe(villageId);
    expect(scorecard.history).toEqual([]);
  });

  it('FR-RS-2: appendScore adds a new timestamped entry without mutating the original', () => {
    const scorecard = createScorecard(villageId);
    const at = new Date('2026-01-01T00:00:00Z');
    const updated = appendScore(scorecard, scoreOf(50), at);

    expect(scorecard.history).toHaveLength(0);
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0]).toEqual({ score: scoreOf(50), recordedAt: at });
  });

  it('FR-RS-2: a single history entry yields a stable trend with delta 0', () => {
    const scorecard = appendScore(createScorecard(villageId), scoreOf(60), new Date());
    expect(scoreTrend(scorecard)).toEqual({ direction: 'stable', delta: 0 });
  });

  it('FR-RS-2: an empty history yields a stable trend with delta 0', () => {
    expect(scoreTrend(createScorecard(villageId))).toEqual({ direction: 'stable', delta: 0 });
  });

  it('FR-RS-2: trend is improving when the latest score is higher than the previous', () => {
    let scorecard = createScorecard(villageId);
    scorecard = appendScore(scorecard, scoreOf(40), new Date('2026-01-01'));
    scorecard = appendScore(scorecard, scoreOf(55), new Date('2026-02-01'));
    expect(scoreTrend(scorecard)).toEqual({ direction: 'improving', delta: 15 });
  });

  it('FR-RS-2: trend is declining when the latest score is lower than the previous', () => {
    let scorecard = createScorecard(villageId);
    scorecard = appendScore(scorecard, scoreOf(70), new Date('2026-01-01'));
    scorecard = appendScore(scorecard, scoreOf(50), new Date('2026-02-01'));
    expect(scoreTrend(scorecard)).toEqual({ direction: 'declining', delta: -20 });
  });

  it('FR-RS-2: trend is stable with delta 0 when consecutive scores are equal', () => {
    let scorecard = createScorecard(villageId);
    scorecard = appendScore(scorecard, scoreOf(65), new Date('2026-01-01'));
    scorecard = appendScore(scorecard, scoreOf(65), new Date('2026-02-01'));
    expect(scoreTrend(scorecard)).toEqual({ direction: 'stable', delta: 0 });
  });

  it('FR-RS-2: trend only compares the two most recent entries', () => {
    let scorecard = createScorecard(villageId);
    scorecard = appendScore(scorecard, scoreOf(20), new Date('2026-01-01'));
    scorecard = appendScore(scorecard, scoreOf(90), new Date('2026-02-01'));
    scorecard = appendScore(scorecard, scoreOf(85), new Date('2026-03-01'));
    expect(scoreTrend(scorecard)).toEqual({ direction: 'declining', delta: -5 });
  });
});
