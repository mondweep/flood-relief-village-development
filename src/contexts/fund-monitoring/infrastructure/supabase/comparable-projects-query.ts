/**
 * Supabase adapter for ComparableProjectsQuery (FR-FM-4c overspend baseline).
 * Reads the denormalized `spent_minor` cache column directly off `funded_projects`
 * rather than re-aggregating `ledger_entries` — that cache is kept in sync by
 * `SupabaseProjectRepository.save`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type ProjectId } from '../../../../shared/index.js';
import type { ComparableProject } from '../../domain/anomaly-detector.js';
import type { ProjectCategory } from '../../domain/types.js';
import type { ComparableCriteria, ComparableProjectsQuery } from '../../application/ports.js';

const SCHEMA = 'fund_monitoring';

export interface ComparableProjectRow {
  readonly id: string;
  readonly category: string;
  readonly spent_minor: number;
  readonly currency: string;
}

/** Pure mapping: a funded_projects row (partial select) -> ComparableProject. */
export function toComparableProject(row: ComparableProjectRow): ComparableProject {
  return {
    projectId: asId<'ProjectId'>(row.id),
    category: row.category as ProjectCategory,
    spent: { amountMinor: row.spent_minor, currency: row.currency },
  };
}

export class SupabaseComparableProjectsQuery implements ComparableProjectsQuery {
  constructor(private readonly client: SupabaseClient) {}

  async findComparable(criteria: ComparableCriteria): Promise<readonly ComparableProject[]> {
    const excludeId: ProjectId = criteria.excludeProjectId;
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('funded_projects')
      .select('id, category, spent_minor, currency')
      .eq('category', criteria.category)
      .neq('id', excludeId);
    if (error) throw new Error(`SupabaseComparableProjectsQuery.findComparable: ${error.message}`);
    return ((data ?? []) as ComparableProjectRow[]).map(toComparableProject);
  }
}
