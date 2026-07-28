import {
  err,
  ok,
  type Clock,
  type EventPublisher,
  type Result,
  type VillageId,
} from '../../../shared/index.js';
import { leadershipTeamFormed } from '../domain/events.js';
import { formLeadershipTeam, type TeamMember } from '../domain/leadership-team.js';
import type { AssignmentRepository, LeadershipTeamRepository } from './ports.js';

export interface FormLeadershipTeamDeps {
  readonly assignments: AssignmentRepository;
  readonly teams: LeadershipTeamRepository;
  readonly events: EventPublisher;
  readonly clock: Clock;
}

export interface FormLeadershipTeamCommand {
  readonly villageId: VillageId;
  readonly members: readonly TeamMember[];
}

/**
 * FR-NC-5: form the village leadership team. A team only exists under an active NGO
 * assignment — the lead NGO is derived from that assignment, never supplied by the caller.
 */
export const formLeadershipTeamUseCase =
  (deps: FormLeadershipTeamDeps) =>
  async (command: FormLeadershipTeamCommand): Promise<Result<void>> => {
    const active = await deps.assignments.findActiveByVillage(command.villageId);
    if (!active) {
      return err(
        'VILLAGE_NOT_ASSIGNED',
        `village ${command.villageId} has no active NGO assignment`,
      );
    }

    const existing = await deps.teams.findByVillage(command.villageId);
    if (existing) {
      return err(
        'LEADERSHIP_TEAM_ALREADY_FORMED',
        `village ${command.villageId} already has a leadership team`,
      );
    }

    const team = formLeadershipTeam({
      villageId: command.villageId,
      ngoId: active.ngoId,
      members: command.members,
      formedAt: deps.clock.now(),
    });
    if (!team.ok) return team;

    await deps.teams.save(team.value);
    await deps.events.publish([leadershipTeamFormed(team.value, deps.clock.now())]);
    return ok(undefined);
  };
