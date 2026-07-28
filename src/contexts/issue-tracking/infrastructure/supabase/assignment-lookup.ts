/**
 * Supabase adapter for the AssignmentLookup anti-corruption port (FR-IT-2): a read-only
 * view onto BC-2 NGO Coordination's `village_assignments` table (cross-schema read,
 * permitted for a named ACL port per ADR-006).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type NgoId, type VillageId } from '../../../../shared/index.js';
import type { AssignmentLookup } from '../../application/ports.js';

export interface ActiveNgoRow {
  readonly ngo_id: string;
}

/** Pure mapping: an active-assignment row (or none) -> the assigned NgoId, or null. */
export function toActiveNgoId(row: ActiveNgoRow | null): NgoId | null {
  return row ? asId<'NgoId'>(row.ngo_id) : null;
}

export class SupabaseAssignmentLookup implements AssignmentLookup {
  constructor(private readonly client: SupabaseClient) {}

  async findActiveNgoForVillage(villageId: VillageId): Promise<NgoId | null> {
    const { data, error } = await this.client
      .schema('ngo_coordination')
      .from('village_assignments')
      .select('ngo_id')
      .eq('village_id', villageId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw new Error(`SupabaseAssignmentLookup.findActiveNgoForVillage: ${error.message}`);
    return toActiveNgoId(data as ActiveNgoRow | null);
  }
}
