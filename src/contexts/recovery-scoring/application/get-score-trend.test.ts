import { describe, expect, it, vi } from 'vitest';
import { asId, type VillageId } from '../../../shared/index.js';
import { GetScoreTrend } from './get-score-trend.js';
import type { ScorecardRepository } from './ports.js';
import { appendScore, createScorecard } from '../domain/village-scorecard.js';
import { equalWeights } from '../domain/weight-set.js';
import type { RecoveryScore } from '../domain/recovery-score.js';

const villageId = asId<'VillageId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as VillageId;

const scoreOf = (composite: number): RecoveryScore => ({
  composite,
  categoryScores: [],
  weights: equalWeights(),
});

function repositoryReturning(scorecard: Awaited<ReturnType<ScorecardRepository['find']>>): ScorecardRepository {
  return {
    find: vi.fn().mockResolvedValue(scorecard),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe('GetScoreTrend use case (FR-RS-2)', () => {
  it('FR-RS-2: finds the scorecard and reports improving trend with delta and latest score', async () => {
    let scorecard = createScorecard(villageId);
    scorecard = appendScore(scorecard, scoreOf(40), new Date('2026-01-01'));
    scorecard = appendScore(scorecard, scoreOf(55), new Date('2026-02-01'));
    const repository = repositoryReturning(scorecard);
    const useCase = new GetScoreTrend(repository);

    const result = await useCase.execute({ villageId });

    expect(repository.find).toHaveBeenCalledWith(villageId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ direction: 'improving', delta: 15, latest: 55 });
  });

  it('FR-RS-2: reports declining trend when the latest score dropped', async () => {
    let scorecard = createScorecard(villageId);
    scorecard = appendScore(scorecard, scoreOf(70), new Date('2026-01-01'));
    scorecard = appendScore(scorecard, scoreOf(50), new Date('2026-02-01'));
    const repository = repositoryReturning(scorecard);
    const useCase = new GetScoreTrend(repository);

    const result = await useCase.execute({ villageId });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ direction: 'declining', delta: -20, latest: 50 });
  });

  it('FR-RS-2: a single history entry yields stable with delta 0', async () => {
    const scorecard = appendScore(createScorecard(villageId), scoreOf(60), new Date('2026-01-01'));
    const repository = repositoryReturning(scorecard);
    const useCase = new GetScoreTrend(repository);

    const result = await useCase.execute({ villageId });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ direction: 'stable', delta: 0, latest: 60 });
  });

  it('FR-RS-2: returns NO_SCORE_HISTORY when the village has no scorecard yet', async () => {
    const repository = repositoryReturning(undefined);
    const useCase = new GetScoreTrend(repository);

    const result = await useCase.execute({ villageId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_SCORE_HISTORY');
  });

  it('FR-RS-2: returns NO_SCORE_HISTORY when the scorecard has an empty history', async () => {
    const repository = repositoryReturning(createScorecard(villageId));
    const useCase = new GetScoreTrend(repository);

    const result = await useCase.execute({ villageId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_SCORE_HISTORY');
  });
});
