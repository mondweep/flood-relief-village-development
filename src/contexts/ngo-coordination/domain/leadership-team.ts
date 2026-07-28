import {
  err,
  ok,
  type NgoId,
  type PersonId,
  type Result,
  type VillageId,
} from '../../../shared/index.js';

/** FR-NC-5: the seven village leadership roles. */
export const LEADERSHIP_ROLES = [
  'leader',
  'volunteer',
  'engineer',
  'teacher',
  'doctor',
  'governmentRep',
  'womensRep',
] as const;

export type LeadershipRole = (typeof LEADERSHIP_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set<string>(LEADERSHIP_ROLES);

export const isLeadershipRole = (raw: string): raw is LeadershipRole => ROLE_SET.has(raw);

export interface TeamMember {
  readonly role: LeadershipRole;
  readonly personId: PersonId;
}

/** BC-2 aggregate: the leadership team of a village led by its assigned NGO. */
export interface LeadershipTeam {
  readonly villageId: VillageId;
  readonly ngoId: NgoId;
  readonly members: readonly TeamMember[];
  readonly formedAt: Date;
}

export interface FormLeadershipTeamInput {
  readonly villageId: VillageId;
  readonly ngoId: NgoId;
  readonly members: readonly TeamMember[];
  readonly formedAt: Date;
}

/**
 * FR-NC-5 invariants: a leader is mandatory, every role must be one of the seven, and each
 * role is held by at most one person.
 */
export function formLeadershipTeam(input: FormLeadershipTeamInput): Result<LeadershipTeam> {
  const seen = new Set<string>();
  for (const member of input.members) {
    if (!isLeadershipRole(member.role)) {
      return err('LEADERSHIP_ROLE_INVALID', `unknown leadership role: ${String(member.role)}`);
    }
    if (seen.has(member.role)) {
      return err(
        'LEADERSHIP_ROLE_DUPLICATED',
        `role ${member.role} is held by more than one person`,
      );
    }
    seen.add(member.role);
  }
  if (!seen.has('leader')) {
    return err('LEADERSHIP_TEAM_LEADER_REQUIRED', 'a leadership team must have a leader');
  }
  return ok({
    villageId: input.villageId,
    ngoId: input.ngoId,
    members: [...input.members],
    formedAt: input.formedAt,
  });
}
