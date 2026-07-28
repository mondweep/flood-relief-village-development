import type {
  AssignmentId,
  NgoId,
  Result,
  VillageId,
} from '../../../shared/index.js';
import type { LeadershipTeam } from '../domain/leadership-team.js';
import type { Ngo } from '../domain/ngo.js';
import type { VillageAssignment } from '../domain/village-assignment.js';

/** Driven port: NGO persistence (FR-NC-1). */
export interface NgoRepository {
  findById(id: NgoId): Promise<Ngo | null>;
  save(ngo: Ngo): Promise<void>;
}

/**
 * Driven port: village assignment persistence (FR-NC-2/3/4/6).
 *
 * `insertActive` is the guarded write for the One Village, One NGO invariant: the adapter
 * must back it with a uniqueness constraint over (villageId) where status = 'active', and
 * translate a conflict into `err('VILLAGE_ALREADY_ASSIGNED', …)` instead of throwing. This
 * closes the read-then-write race that a pre-check alone cannot.
 */
export interface AssignmentRepository {
  findById(id: AssignmentId): Promise<VillageAssignment | null>;
  findActiveByVillage(villageId: VillageId): Promise<VillageAssignment | null>;
  countActiveByNgo(ngoId: NgoId): Promise<number>;
  insertActive(assignment: VillageAssignment): Promise<Result<void>>;
  save(assignment: VillageAssignment): Promise<void>;
  /** Of the given candidates, the ids that currently have an active assignment. */
  findAssignedVillageIds(candidates: readonly VillageId[]): Promise<readonly VillageId[]>;
}

/** Driven port: leadership team persistence (FR-NC-5). */
export interface LeadershipTeamRepository {
  findByVillage(villageId: VillageId): Promise<LeadershipTeam | null>;
  save(team: LeadershipTeam): Promise<void>;
}

/**
 * Driven port (anti-corruption layer onto BC-1 Village Registry): the affected villages
 * that need a lead NGO (FR-NC-6).
 */
export interface AffectedVillageLookup {
  listAffectedVillageIds(): Promise<readonly VillageId[]>;
}
