import { describe, expect, it } from 'vitest';
import { asId, unwrap, type VillageId } from '../../../../shared/index.js';
import { calculateRecoveryScore } from '../../domain/recovery-score.js';
import { SCORE_CATEGORIES } from '../../domain/score-category.js';
import { fromScoreEntryRow, toNewScoreEntryRow } from './scorecard-repository.js';

const villageId = (): VillageId => asId<'VillageId'>('20000000-0000-4000-8000-000000000001');

const aScore = () =>
  unwrap(calculateRecoveryScore(SCORE_CATEGORIES.map((category) => ({ category, value: 60 }))));

describe('toNewScoreEntryRow / fromScoreEntryRow', () => {
  it('round-trips a score entry, preserving composite, category scores and weights', () => {
    const entry = { score: aScore(), recordedAt: new Date('2026-07-28T09:00:00.000Z') };

    const row = toNewScoreEntryRow(villageId(), entry);
    expect(row.village_id).toBe(villageId());
    expect(row.composite).toBe(60);
    expect(row.calculated_at).toBe('2026-07-28T09:00:00.000Z');

    const rebuilt = fromScoreEntryRow(row);
    expect(rebuilt).toEqual(entry);
  });

  it('preserves custom weights through the jsonb payload', () => {
    const weights = Object.fromEntries(SCORE_CATEGORIES.map((c, i) => [c, i === 0 ? 1 : 0])) as Record<
      (typeof SCORE_CATEGORIES)[number],
      number
    >;
    const score = unwrap(
      calculateRecoveryScore(
        SCORE_CATEGORIES.map((category) => ({ category, value: 50 })),
        weights,
      ),
    );
    const entry = { score, recordedAt: new Date('2026-07-28T09:00:00.000Z') };

    const rebuilt = fromScoreEntryRow(toNewScoreEntryRow(villageId(), entry));

    expect(rebuilt.score.weights).toEqual(weights);
  });
});
