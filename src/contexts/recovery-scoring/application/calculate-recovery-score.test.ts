import { describe, expect, it, vi } from 'vitest';
import { asId, type VillageId } from '../../../shared/index.js';
import { CalculateRecoveryScore } from './calculate-recovery-score.js';
import type { ScorecardRepository } from './ports.js';
import { SCORE_CATEGORIES } from '../domain/score-category.js';
import { createScorecard } from '../domain/village-scorecard.js';

const villageId = asId<'VillageId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as VillageId;
const validScores = SCORE_CATEGORIES.map((category) => ({ category, value: 60 }));

function buildCollaborators(existing = createScorecard(villageId)) {
  const repository: ScorecardRepository = {
    find: vi.fn().mockResolvedValue(existing),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const clock = { now: vi.fn().mockReturnValue(new Date('2026-07-28T00:00:00Z')) };
  return { repository, publisher, clock };
}

function savedScorecard(repository: ScorecardRepository) {
  const calls = (repository.save as ReturnType<typeof vi.fn>).mock.calls;
  const firstCall = calls[0];
  if (!firstCall) throw new Error('repository.save was never called');
  return firstCall[0];
}

describe('CalculateRecoveryScore use case (FR-RS-1, FR-RS-3)', () => {
  it('FR-RS-1: finds the scorecard, appends the computed score, saves it and publishes RecoveryScoreCalculated', async () => {
    const { repository, publisher, clock } = buildCollaborators();
    const useCase = new CalculateRecoveryScore(repository, publisher, clock);

    const result = await useCase.execute({ villageId, categoryScores: validScores });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(60);

    expect(repository.find).toHaveBeenCalledWith(villageId);
    expect(repository.save).toHaveBeenCalledTimes(1);
    const saved = savedScorecard(repository);
    expect(saved.villageId).toBe(villageId);
    expect(saved.history).toHaveLength(1);
    expect(saved.history[0].score.composite).toBe(60);
    expect(saved.history[0].recordedAt).toEqual(clock.now());

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'RecoveryScoreCalculated',
        occurredAt: clock.now(),
        payload: { villageId, score: 60, at: clock.now() },
      }),
    ]);
  });

  it('FR-RS-1: creates a fresh scorecard when the repository has none for the village', async () => {
    const { repository, publisher, clock } = buildCollaborators(undefined as never);
    (repository.find as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const useCase = new CalculateRecoveryScore(repository, publisher, clock);

    const result = await useCase.execute({ villageId, categoryScores: validScores });

    expect(result.ok).toBe(true);
    const saved = savedScorecard(repository);
    expect(saved.history).toHaveLength(1);
  });

  it('FR-RS-1: appends to existing history rather than replacing it', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const withHistory = {
      villageId,
      history: [{ score: { composite: 30, categoryScores: [], weights: {} }, recordedAt: at }],
    };
    const { repository, publisher, clock } = buildCollaborators(withHistory as never);
    const useCase = new CalculateRecoveryScore(repository, publisher, clock);

    await useCase.execute({ villageId, categoryScores: validScores });

    const saved = savedScorecard(repository);
    expect(saved.history).toHaveLength(2);
    expect(saved.history[0]?.score.composite).toBe(30);
    expect(saved.history[1]?.score.composite).toBe(60);
  });

  it('FR-RS-3: rejects incomplete category sets without touching the repository or publisher', async () => {
    const { repository, publisher, clock } = buildCollaborators();
    const useCase = new CalculateRecoveryScore(repository, publisher, clock);

    const incomplete = validScores.filter((s) => s.category !== 'electricity');
    const result = await useCase.execute({ villageId, categoryScores: incomplete });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CATEGORIES_INCOMPLETE');
    expect(repository.find).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-RS-3: rejects an out-of-range category score without touching the repository or publisher', async () => {
    const { repository, publisher, clock } = buildCollaborators();
    const useCase = new CalculateRecoveryScore(repository, publisher, clock);

    const outOfRange = validScores.map((s) => (s.category === 'road' ? { ...s, value: 200 } : s));
    const result = await useCase.execute({ villageId, categoryScores: outOfRange });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SCORE_OUT_OF_RANGE');
    expect(repository.save).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('FR-RS-3: rejects invalid weights without touching the repository or publisher', async () => {
    const { repository, publisher, clock } = buildCollaborators();
    const useCase = new CalculateRecoveryScore(repository, publisher, clock);

    const badWeights = Object.fromEntries(SCORE_CATEGORIES.map((c) => [c, 0.5]));
    const result = await useCase.execute({ villageId, categoryScores: validScores, weights: badWeights });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WEIGHTS_INVALID');
    expect(repository.save).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('sanity fixture: a plausible category breakdown yields the concept document village index of 42', async () => {
    const { repository, publisher, clock } = buildCollaborators();
    const useCase = new CalculateRecoveryScore(repository, publisher, clock);

    const values = [35, 50, 60, 30, 45, 25, 40, 55, 38, 44, 40];
    const scores = SCORE_CATEGORIES.map((category, i) => ({ category, value: values[i]! }));

    const result = await useCase.execute({ villageId, categoryScores: scores });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.composite).toBe(42);
  });
});
