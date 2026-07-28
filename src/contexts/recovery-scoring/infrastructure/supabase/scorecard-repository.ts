/**
 * Supabase adapter for ScorecardRepository (BC-5, ADR-003 schema `recovery_scoring`).
 *
 * Mapping note: `score_entries.categories` is documented as a flat
 * `{category: value}` map, but the domain's `RecoveryScore` also carries the `WeightSet`
 * used to compute the composite — there is no separate weights column. Both are
 * serialized together into that jsonb column as `{ categoryScores, weights }` (a superset
 * of the documented shape) so the full score can be losslessly rehydrated.
 *
 * `history` is append-only (FR-RS-2): `save` inserts only the tail beyond what is already
 * persisted for the village.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VillageId } from '../../../../shared/index.js';
import type { CategoryScore } from '../../domain/category-score.js';
import type { WeightSet } from '../../domain/weight-set.js';
import type { ScoreHistoryEntry, VillageScorecard } from '../../domain/village-scorecard.js';
import type { ScorecardRepository } from '../../application/ports.js';

const SCHEMA = 'recovery_scoring';

export interface ScoreCategoriesPayload {
  readonly categoryScores: readonly CategoryScore[];
  readonly weights: WeightSet;
}

export interface ScoreEntryRow {
  readonly id: string;
  readonly village_id: string;
  readonly composite: number;
  readonly categories: ScoreCategoriesPayload;
  readonly calculated_at: string;
  readonly recorded_at: string;
}

/** Pure mapping: a single new ScoreHistoryEntry -> its insertable row. */
export function toNewScoreEntryRow(villageId: VillageId, entry: ScoreHistoryEntry): ScoreEntryRow {
  return {
    id: randomUUID(),
    village_id: villageId,
    composite: entry.score.composite,
    categories: { categoryScores: entry.score.categoryScores, weights: entry.score.weights },
    calculated_at: entry.recordedAt.toISOString(),
    recorded_at: entry.recordedAt.toISOString(),
  };
}

/** Pure mapping: a `score_entries` row -> a ScoreHistoryEntry. */
export function fromScoreEntryRow(row: ScoreEntryRow): ScoreHistoryEntry {
  return {
    score: {
      composite: row.composite,
      categoryScores: row.categories.categoryScores,
      weights: row.categories.weights,
    },
    recordedAt: new Date(row.recorded_at),
  };
}

export class SupabaseScorecardRepository implements ScorecardRepository {
  constructor(private readonly client: SupabaseClient) {}

  async find(villageId: VillageId): Promise<VillageScorecard | undefined> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('score_entries')
      .select('*')
      .eq('village_id', villageId)
      .order('calculated_at', { ascending: true });
    if (error) throw new Error(`SupabaseScorecardRepository.find: ${error.message}`);

    const rows = (data ?? []) as ScoreEntryRow[];
    if (rows.length === 0) return undefined;
    return { villageId, history: rows.map(fromScoreEntryRow) };
  }

  async save(scorecard: VillageScorecard): Promise<void> {
    const { count, error: countError } = await this.client
      .schema(SCHEMA)
      .from('score_entries')
      .select('id', { count: 'exact', head: true })
      .eq('village_id', scorecard.villageId);
    if (countError) throw new Error(`SupabaseScorecardRepository.save (count): ${countError.message}`);

    const persisted = count ?? 0;
    const newEntries = scorecard.history.slice(persisted).map((entry) => toNewScoreEntryRow(scorecard.villageId, entry));
    if (newEntries.length > 0) {
      const { error } = await this.client.schema(SCHEMA).from('score_entries').insert(newEntries);
      if (error) throw new Error(`SupabaseScorecardRepository.save: ${error.message}`);
    }
  }
}
