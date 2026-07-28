import { type Result, ok, err, type VillageId } from '../../../shared/index.js';
import { scoreTrend, type TrendDirection } from '../domain/village-scorecard.js';
import type { ScorecardRepository } from './ports.js';

export interface GetScoreTrendInput {
  readonly villageId: VillageId;
}

export interface ScoreTrendResult {
  readonly direction: TrendDirection;
  readonly delta: number;
  readonly latest: number;
}

/**
 * FR-RS-2: expose a village's score trend (improving/declining/stable + delta) from its
 * append-only history. A single entry (or no history at all) is 'stable' with delta 0;
 * no history yet is reported as NO_SCORE_HISTORY.
 */
export class GetScoreTrend {
  constructor(private readonly repository: ScorecardRepository) {}

  async execute(input: GetScoreTrendInput): Promise<Result<ScoreTrendResult>> {
    const scorecard = await this.repository.find(input.villageId);
    if (!scorecard || scorecard.history.length === 0) {
      return err('NO_SCORE_HISTORY', `no score history for village: ${input.villageId}`);
    }

    const trend = scoreTrend(scorecard);
    const latest = scorecard.history[scorecard.history.length - 1]!.score.composite;
    return ok({ ...trend, latest });
  }
}
