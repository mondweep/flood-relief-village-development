/**
 * Supabase adapter for the AffectedVillageLookup anti-corruption port (FR-NC-6):
 * a read-only view onto BC-1 Village Registry's `villages` table (cross-schema read,
 * permitted for a named ACL port per ADR-006).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type VillageId } from '../../../../shared/index.js';
import type { AffectedVillageLookup } from '../../application/ports.js';

export interface AffectedVillageIdRow {
  readonly id: string;
}

/** Pure mapping: rows of `{ id }` -> branded VillageIds. */
export function toVillageIds(rows: readonly AffectedVillageIdRow[]): readonly VillageId[] {
  return rows.map((row) => asId<'VillageId'>(row.id));
}

export class SupabaseAffectedVillageLookup implements AffectedVillageLookup {
  constructor(private readonly client: SupabaseClient) {}

  async listAffectedVillageIds(): Promise<readonly VillageId[]> {
    const { data, error } = await this.client
      .schema('village_registry')
      .from('villages')
      .select('id')
      .neq('severity', 'unaffected');
    if (error) throw new Error(`SupabaseAffectedVillageLookup.listAffectedVillageIds: ${error.message}`);
    return toVillageIds((data ?? []) as AffectedVillageIdRow[]);
  }
}
