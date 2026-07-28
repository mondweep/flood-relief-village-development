import type { VillageId } from '../../../shared/index.js';
import type { VillageScorecard } from '../domain/village-scorecard.js';

/** Driven port: persistence for VillageScorecard aggregates. */
export interface ScorecardRepository {
  find(villageId: VillageId): Promise<VillageScorecard | undefined>;
  save(scorecard: VillageScorecard): Promise<void>;
}
