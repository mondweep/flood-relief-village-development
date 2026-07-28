import { describe, expect, it } from 'vitest';
import { LEADERSHIP_TEAM_FORMED } from '../domain/events.js';
import type { TeamMember } from '../domain/leadership-team.js';
import { formLeadershipTeamUseCase } from './form-leadership-team.js';
import {
  NOW,
  anAssignment,
  assignmentRepositoryMock,
  clockStub,
  eventPublisherMock,
  leadershipTeamRepositoryMock,
  ngoId,
  personId,
  publishedEvents,
  villageId,
} from './test-doubles.js';

const makeDeps = () => {
  const assignments = assignmentRepositoryMock();
  const teams = leadershipTeamRepositoryMock();
  const events = eventPublisherMock();
  assignments.findActiveByVillage.mockResolvedValue(
    anAssignment({ villageId: villageId(1), ngoId: ngoId(1) }),
  );
  return { assignments, teams, events, clock: clockStub() };
};

const fullTeam: readonly TeamMember[] = [
  { role: 'leader', personId: personId(1) },
  { role: 'volunteer', personId: personId(2) },
  { role: 'engineer', personId: personId(3) },
  { role: 'teacher', personId: personId(4) },
  { role: 'doctor', personId: personId(5) },
  { role: 'governmentRep', personId: personId(6) },
  { role: 'womensRep', personId: personId(7) },
];

describe('FormLeadershipTeam (FR-NC-5)', () => {
  it('FR-NC-5: saves the seven-role team bound to the village’s active lead NGO', async () => {
    const deps = makeDeps();

    const result = await formLeadershipTeamUseCase(deps)({
      villageId: villageId(1),
      members: fullTeam,
    });

    expect(result.ok).toBe(true);
    expect(deps.assignments.findActiveByVillage).toHaveBeenCalledWith(villageId(1));
    expect(deps.teams.save).toHaveBeenCalledTimes(1);
    expect(deps.teams.save).toHaveBeenCalledWith({
      villageId: villageId(1),
      ngoId: ngoId(1),
      members: fullTeam,
      formedAt: NOW,
    });
  });

  it('FR-NC-5: publishes LeadershipTeamFormed with every role/person pairing', async () => {
    const deps = makeDeps();

    await formLeadershipTeamUseCase(deps)({ villageId: villageId(1), members: fullTeam });

    expect(publishedEvents(deps.events)).toEqual([
      {
        type: LEADERSHIP_TEAM_FORMED,
        occurredAt: NOW,
        payload: {
          villageId: villageId(1),
          ngoId: ngoId(1),
          members: fullTeam.map((m) => ({ role: m.role, personId: m.personId })),
        },
      },
    ]);
  });

  it('FR-NC-5: accepts a partial team as long as a leader is present', async () => {
    const deps = makeDeps();

    const result = await formLeadershipTeamUseCase(deps)({
      villageId: villageId(1),
      members: [
        { role: 'leader', personId: personId(1) },
        { role: 'doctor', personId: personId(5) },
      ],
    });

    expect(result.ok).toBe(true);
    expect(deps.teams.save).toHaveBeenCalledTimes(1);
  });

  it('FR-NC-5: rejects a team without a leader and saves nothing', async () => {
    const deps = makeDeps();

    const result = await formLeadershipTeamUseCase(deps)({
      villageId: villageId(1),
      members: [
        { role: 'engineer', personId: personId(3) },
        { role: 'teacher', personId: personId(4) },
      ],
    });

    expect(!result.ok && result.error.code).toBe('LEADERSHIP_TEAM_LEADER_REQUIRED');
    expect(deps.teams.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-5: rejects an empty team (no leader) and saves nothing', async () => {
    const deps = makeDeps();

    const result = await formLeadershipTeamUseCase(deps)({
      villageId: villageId(1),
      members: [],
    });

    expect(!result.ok && result.error.code).toBe('LEADERSHIP_TEAM_LEADER_REQUIRED');
    expect(deps.teams.save).not.toHaveBeenCalled();
  });

  it('FR-NC-5: rejects two people holding the same role', async () => {
    const deps = makeDeps();

    const result = await formLeadershipTeamUseCase(deps)({
      villageId: villageId(1),
      members: [
        { role: 'leader', personId: personId(1) },
        { role: 'doctor', personId: personId(5) },
        { role: 'doctor', personId: personId(6) },
      ],
    });

    expect(!result.ok && result.error.code).toBe('LEADERSHIP_ROLE_DUPLICATED');
    expect(deps.teams.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-5: rejects forming a team for a village with no active NGO assignment', async () => {
    const deps = makeDeps();
    deps.assignments.findActiveByVillage.mockResolvedValue(null);

    const result = await formLeadershipTeamUseCase(deps)({
      villageId: villageId(1),
      members: fullTeam,
    });

    expect(!result.ok && result.error.code).toBe('VILLAGE_NOT_ASSIGNED');
    expect(deps.teams.findByVillage).not.toHaveBeenCalled();
    expect(deps.teams.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });

  it('FR-NC-5: rejects forming a second team for the same village', async () => {
    const deps = makeDeps();
    deps.teams.findByVillage.mockResolvedValue({
      villageId: villageId(1),
      ngoId: ngoId(1),
      members: fullTeam,
      formedAt: NOW,
    });

    const result = await formLeadershipTeamUseCase(deps)({
      villageId: villageId(1),
      members: fullTeam,
    });

    expect(!result.ok && result.error.code).toBe('LEADERSHIP_TEAM_ALREADY_FORMED');
    expect(deps.teams.save).not.toHaveBeenCalled();
    expect(deps.events.publish).not.toHaveBeenCalled();
  });
});
