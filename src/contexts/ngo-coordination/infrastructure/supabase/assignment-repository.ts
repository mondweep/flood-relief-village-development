/**
 * Supabase adapter for AssignmentRepository (BC-2, ADR-003 schema `ngo_coordination`).
 * `insertActive` relies on the migration's partial unique index
 * `one_active_ngo_per_village` (village_id where status = 'active') to close the
 * read-then-write race — a unique-violation (Postgres 23505) becomes
 * `err('VILLAGE_ALREADY_ASSIGNED', ...)` instead of throwing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, err, ok, type NgoId, type Result, type VillageId } from '../../../../shared/index.js';
import type { AssignmentStatus, VillageAssignment } from '../../domain/village-assignment.js';
import type { AssignmentId } from '../../../../shared/index.js';
import type { AssignmentRepository } from '../../application/ports.js';

const SCHEMA = 'ngo_coordination';
const UNIQUE_VIOLATION = '23505';

export interface AssignmentRow {
  readonly id: string;
  readonly village_id: string;
  readonly ngo_id: string;
  readonly status: string;
  readonly assigned_at: string;
  readonly released_at: string | null;
  readonly release_reason: string | null;
}

/** Pure mapping: VillageAssignment -> `village_assignments` row. */
export function toAssignmentRow(assignment: VillageAssignment): AssignmentRow {
  return {
    id: assignment.id,
    village_id: assignment.villageId,
    ngo_id: assignment.ngoId,
    status: assignment.status,
    assigned_at: assignment.assignedAt.toISOString(),
    released_at: assignment.releasedAt ? assignment.releasedAt.toISOString() : null,
    release_reason: assignment.releaseReason,
  };
}

export function fromAssignmentRow(row: AssignmentRow): VillageAssignment {
  return {
    id: asId<'AssignmentId'>(row.id),
    villageId: asId<'VillageId'>(row.village_id),
    ngoId: asId<'NgoId'>(row.ngo_id),
    status: row.status as AssignmentStatus,
    assignedAt: new Date(row.assigned_at),
    releasedAt: row.released_at ? new Date(row.released_at) : null,
    releaseReason: row.release_reason,
  };
}

export class SupabaseAssignmentRepository implements AssignmentRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: AssignmentId): Promise<VillageAssignment | null> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('village_assignments')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`SupabaseAssignmentRepository.findById: ${error.message}`);
    return data ? fromAssignmentRow(data as AssignmentRow) : null;
  }

  async findActiveByVillage(villageId: VillageId): Promise<VillageAssignment | null> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('village_assignments')
      .select('*')
      .eq('village_id', villageId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw new Error(`SupabaseAssignmentRepository.findActiveByVillage: ${error.message}`);
    return data ? fromAssignmentRow(data as AssignmentRow) : null;
  }

  async countActiveByNgo(ngoId: NgoId): Promise<number> {
    const { count, error } = await this.client
      .schema(SCHEMA)
      .from('village_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('ngo_id', ngoId)
      .eq('status', 'active');
    if (error) throw new Error(`SupabaseAssignmentRepository.countActiveByNgo: ${error.message}`);
    return count ?? 0;
  }

  async insertActive(assignment: VillageAssignment): Promise<Result<void>> {
    const { error } = await this.client
      .schema(SCHEMA)
      .from('village_assignments')
      .insert(toAssignmentRow(assignment));
    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        return err(
          'VILLAGE_ALREADY_ASSIGNED',
          `village ${assignment.villageId} already has an active NGO assignment`,
        );
      }
      throw new Error(`SupabaseAssignmentRepository.insertActive: ${error.message}`);
    }
    return ok(undefined);
  }

  async save(assignment: VillageAssignment): Promise<void> {
    const { error } = await this.client
      .schema(SCHEMA)
      .from('village_assignments')
      .upsert(toAssignmentRow(assignment));
    if (error) throw new Error(`SupabaseAssignmentRepository.save: ${error.message}`);
  }

  async findAssignedVillageIds(candidates: readonly VillageId[]): Promise<readonly VillageId[]> {
    if (candidates.length === 0) return [];

    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('village_assignments')
      .select('village_id')
      .eq('status', 'active')
      .in('village_id', candidates as readonly string[]);
    if (error) throw new Error(`SupabaseAssignmentRepository.findAssignedVillageIds: ${error.message}`);
    return ((data ?? []) as readonly { village_id: string }[]).map((row) => asId<'VillageId'>(row.village_id));
  }
}
