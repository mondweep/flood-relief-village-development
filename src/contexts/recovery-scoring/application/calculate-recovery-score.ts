import {
  type Clock,
  type EventPublisher,
  type Result,
  type VillageId,
  domainEvent,
} from '../../../shared/index.js';
import type { CategoryScoreInput } from '../domain/category-score.js';
import type { ScoreCategory } from '../domain/score-category.js';
import { calculateRecoveryScore, type RecoveryScore } from '../domain/recovery-score.js';
import { appendScore, createScorecard } from '../domain/village-scorecard.js';
import type { ScorecardRepository } from './ports.js';

export interface CalculateRecoveryScoreInput {
  readonly villageId: VillageId;
  readonly categoryScores: readonly CategoryScoreInput[];
  readonly weights?: Readonly<Partial<Record<ScoreCategory, number>>>;
}

/**
 * FR-RS-1: compute a village's weighted composite Recovery Score and persist it.
 * FR-RS-3: reject incomplete category sets, out-of-range scores or invalid weights
 * before touching any collaborator.
 */
export class CalculateRecoveryScore {
  constructor(
    private readonly repository: ScorecardRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async execute(input: CalculateRecoveryScoreInput): Promise<Result<RecoveryScore>> {
    const calculated = calculateRecoveryScore(input.categoryScores, input.weights);
    if (!calculated.ok) return calculated;

    const existing = await this.repository.find(input.villageId);
    const scorecard = existing ?? createScorecard(input.villageId);
    const at = this.clock.now();
    const updated = appendScore(scorecard, calculated.value, at);

    await this.repository.save(updated);
    await this.publisher.publish([
      domainEvent('RecoveryScoreCalculated', at, {
        villageId: input.villageId,
        score: calculated.value.composite,
        at,
      }),
    ]);

    return calculated;
  }
}
