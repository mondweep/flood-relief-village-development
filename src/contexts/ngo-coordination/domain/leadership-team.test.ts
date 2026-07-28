import { describe, expect, it } from 'vitest';
import { asId, unwrap, type PersonId } from '../../../shared/index.js';
import {
  LEADERSHIP_ROLES,
  formLeadershipTeam,
  isLeadershipRole,
  type LeadershipRole,
  type TeamMember,
} from './leadership-team.js';

// Pure aggregate logic: state-based assertions apply (ADR-004 §5).
const village = asId<'VillageId'>('20000000-0000-4000-8000-000000000001');
const ngo = asId<'NgoId'>('10000000-0000-4000-8000-000000000001');
const formedAt = new Date('2026-07-10T00:00:00.000Z');
const person = (n: number): PersonId =>
  asId<'PersonId'>(`40000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`);

const withMembers = (members: readonly TeamMember[]) =>
  formLeadershipTeam({ villageId: village, ngoId: ngo, members, formedAt });

describe('LeadershipTeam aggregate', () => {
  it('FR-NC-5: defines exactly the seven village roles', () => {
    expect([...LEADERSHIP_ROLES]).toEqual([
      'leader',
      'volunteer',
      'engineer',
      'teacher',
      'doctor',
      'governmentRep',
      'womensRep',
    ]);
    expect(isLeadershipRole('leader')).toBe(true);
    expect(isLeadershipRole('mayor')).toBe(false);
  });

  it('FR-NC-5: forms a full team with one person per role', () => {
    const members = LEADERSHIP_ROLES.map((role, i) => ({ role, personId: person(i + 1) }));

    const team = unwrap(withMembers(members));

    expect(team.villageId).toBe(village);
    expect(team.ngoId).toBe(ngo);
    expect(team.members).toHaveLength(7);
    expect(team.formedAt).toBe(formedAt);
  });

  it('FR-NC-5: a leader is mandatory', () => {
    const result = withMembers([{ role: 'doctor', personId: person(1) }]);

    expect(!result.ok && result.error.code).toBe('LEADERSHIP_TEAM_LEADER_REQUIRED');
  });

  it('FR-NC-5: an empty team is rejected', () => {
    const result = withMembers([]);

    expect(!result.ok && result.error.code).toBe('LEADERSHIP_TEAM_LEADER_REQUIRED');
  });

  it.each([...LEADERSHIP_ROLES])(
    'FR-NC-5: role %s may be held by at most one person',
    (role: LeadershipRole) => {
      const members: TeamMember[] = [
        { role: 'leader', personId: person(1) },
        { role, personId: person(2) },
        { role, personId: person(3) },
      ];

      const result = withMembers(members);

      expect(!result.ok && result.error.code).toBe('LEADERSHIP_ROLE_DUPLICATED');
    },
  );

  it('FR-NC-5: an unknown role is rejected', () => {
    const result = withMembers([
      { role: 'leader', personId: person(1) },
      { role: 'mayor' as LeadershipRole, personId: person(2) },
    ]);

    expect(!result.ok && result.error.code).toBe('LEADERSHIP_ROLE_INVALID');
  });

  it('FR-NC-5: the member list is copied so later caller mutation cannot corrupt the team', () => {
    const members: TeamMember[] = [{ role: 'leader', personId: person(1) }];

    const team = unwrap(withMembers(members));
    members.push({ role: 'doctor', personId: person(2) });

    expect(team.members).toHaveLength(1);
  });
});
