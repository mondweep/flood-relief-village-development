import { describe, expect, it } from 'vitest';
import { asId, type NgoId, type PersonId, type VillageId } from '../../../../shared/index.js';
import type { LeadershipTeam, TeamMember } from '../../domain/leadership-team.js';
import { fromLeadershipTeamRow, toLeadershipTeamRow, type LeadershipTeamRow } from './leadership-team-repository.js';

const villageId = (): VillageId => asId<'VillageId'>('20000000-0000-4000-8000-000000000001');
const ngoId = (): NgoId => asId<'NgoId'>('10000000-0000-4000-8000-000000000001');
const personId = (n: number): PersonId => asId<'PersonId'>(`40000000-0000-4000-8000-00000000000${n}`);

describe('toLeadershipTeamRow', () => {
  it('spreads members across their fixed role columns', () => {
    const members: TeamMember[] = [
      { role: 'leader', personId: personId(1) },
      { role: 'engineer', personId: personId(2) },
      { role: 'governmentRep', personId: personId(3) },
    ];
    const team: LeadershipTeam = { villageId: villageId(), ngoId: ngoId(), members, formedAt: new Date('2026-07-28T09:00:00.000Z') };

    const row = toLeadershipTeamRow(team, 'row-id-1');

    expect(row).toEqual({
      id: 'row-id-1',
      village_id: villageId(),
      leader: personId(1),
      volunteer: null,
      engineer: personId(2),
      teacher: null,
      doctor: null,
      government_rep: personId(3),
      womens_rep: null,
      formed_at: '2026-07-28T09:00:00.000Z',
    });
  });

  it('throws when the team has no leader (should never happen given the domain invariant)', () => {
    const team: LeadershipTeam = { villageId: villageId(), ngoId: ngoId(), members: [], formedAt: new Date() };
    expect(() => toLeadershipTeamRow(team, 'row-id-1')).toThrow(/leader/i);
  });
});

describe('fromLeadershipTeamRow', () => {
  it('rebuilds the members array, skipping unfilled roles, and attaches the given ngoId', () => {
    const row: LeadershipTeamRow = {
      id: 'row-id-1',
      village_id: villageId(),
      leader: personId(1),
      volunteer: null,
      engineer: personId(2),
      teacher: null,
      doctor: null,
      government_rep: null,
      womens_rep: null,
      formed_at: '2026-07-28T09:00:00.000Z',
    };

    const team = fromLeadershipTeamRow(row, ngoId());

    expect(team).toEqual({
      villageId: villageId(),
      ngoId: ngoId(),
      members: [
        { role: 'leader', personId: personId(1) },
        { role: 'engineer', personId: personId(2) },
      ],
      formedAt: new Date('2026-07-28T09:00:00.000Z'),
    });
  });
});
