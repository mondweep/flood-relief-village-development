/**
 * Supabase adapter for LeadershipTeamRepository (BC-2, ADR-003 schema `ngo_coordination`).
 *
 * Mapping note: `leadership_teams` has one fixed column per role (leader, volunteer,
 * engineer, teacher, doctor, government_rep, womens_rep) instead of a members table, and
 * it carries no `ngo_id` column — the migration ties a team to its village only. The
 * `LeadershipTeam.ngoId` field is therefore never stored; it is derived on read from the
 * village's *current* active assignment in `village_assignments` (same schema, no ACL
 * needed), which matches the domain's own rule that "the lead NGO is derived from the
 * assignment, never supplied by the caller" (see `form-leadership-team.ts`).
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { asId, type NgoId, type PersonId, type VillageId } from '../../../../shared/index.js';
import { type LeadershipRole, type LeadershipTeam, type TeamMember } from '../../domain/leadership-team.js';
import type { LeadershipTeamRepository } from '../../application/ports.js';

const SCHEMA = 'ngo_coordination';

export interface LeadershipTeamRow {
  readonly id: string;
  readonly village_id: string;
  readonly leader: string;
  readonly volunteer: string | null;
  readonly engineer: string | null;
  readonly teacher: string | null;
  readonly doctor: string | null;
  readonly government_rep: string | null;
  readonly womens_rep: string | null;
  readonly formed_at: string;
}

const ROLE_COLUMN: Readonly<Record<LeadershipRole, keyof LeadershipTeamRow>> = {
  leader: 'leader',
  volunteer: 'volunteer',
  engineer: 'engineer',
  teacher: 'teacher',
  doctor: 'doctor',
  governmentRep: 'government_rep',
  womensRep: 'womens_rep',
};

/** Pure mapping: LeadershipTeam -> its row (a fresh `id` is supplied by the caller). */
export function toLeadershipTeamRow(team: LeadershipTeam, id: string): LeadershipTeamRow {
  const byRole = new Map(team.members.map((m) => [m.role, m.personId] as const));
  const leader = byRole.get('leader');
  if (leader === undefined) {
    throw new Error('LeadershipTeam without a leader cannot be persisted (domain invariant violated)');
  }

  return {
    id,
    village_id: team.villageId,
    leader,
    volunteer: byRole.get('volunteer') ?? null,
    engineer: byRole.get('engineer') ?? null,
    teacher: byRole.get('teacher') ?? null,
    doctor: byRole.get('doctor') ?? null,
    government_rep: byRole.get('governmentRep') ?? null,
    womens_rep: byRole.get('womensRep') ?? null,
    formed_at: team.formedAt.toISOString(),
  };
}

/** Pure mapping: row + the derived ngoId -> LeadershipTeam. */
export function fromLeadershipTeamRow(row: LeadershipTeamRow, ngoId: NgoId): LeadershipTeam {
  const members: TeamMember[] = [];
  const add = (role: LeadershipRole) => {
    const value = row[ROLE_COLUMN[role]];
    if (value !== null) members.push({ role, personId: asId<'PersonId'>(value) });
  };
  (Object.keys(ROLE_COLUMN) as LeadershipRole[]).forEach(add);

  return {
    villageId: asId<'VillageId'>(row.village_id),
    ngoId,
    members,
    formedAt: new Date(row.formed_at),
  };
}

export class SupabaseLeadershipTeamRepository implements LeadershipTeamRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findByVillage(villageId: VillageId): Promise<LeadershipTeam | null> {
    const { data, error } = await this.client
      .schema(SCHEMA)
      .from('leadership_teams')
      .select('*')
      .eq('village_id', villageId)
      .maybeSingle();
    if (error) throw new Error(`SupabaseLeadershipTeamRepository.findByVillage: ${error.message}`);
    if (!data) return null;

    const { data: assignment, error: assignmentError } = await this.client
      .schema(SCHEMA)
      .from('village_assignments')
      .select('ngo_id')
      .eq('village_id', villageId)
      .eq('status', 'active')
      .maybeSingle();
    if (assignmentError) {
      throw new Error(`SupabaseLeadershipTeamRepository.findByVillage (assignment): ${assignmentError.message}`);
    }
    if (!assignment) {
      throw new Error(
        `SupabaseLeadershipTeamRepository.findByVillage: village ${villageId} has a leadership team but no active NGO assignment`,
      );
    }

    return fromLeadershipTeamRow(data as LeadershipTeamRow, asId<'NgoId'>((assignment as { ngo_id: string }).ngo_id));
  }

  async save(team: LeadershipTeam): Promise<void> {
    const row = toLeadershipTeamRow(team, randomUUID());
    const { error } = await this.client
      .schema(SCHEMA)
      .from('leadership_teams')
      .upsert(row, { onConflict: 'village_id' });
    if (error) throw new Error(`SupabaseLeadershipTeamRepository.save: ${error.message}`);
  }
}
