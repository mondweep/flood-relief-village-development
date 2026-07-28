import { domainEvent, type DomainEvent } from '../../../shared/index.js';
import type { LeadershipTeam } from './leadership-team.js';
import type { Ngo } from './ngo.js';
import type { VillageAssignment } from './village-assignment.js';

/** BC-2 published language (PRD §5 BC-2, ADR-006). */
export const NGO_REGISTERED = 'NgoRegistered';
export const NGO_VERIFIED = 'NgoVerified';
export const NGO_ASSIGNED = 'NgoAssigned';
export const ASSIGNMENT_RELEASED = 'AssignmentReleased';
export const LEADERSHIP_TEAM_FORMED = 'LeadershipTeamFormed';

export const ngoRegistered = (ngo: Ngo, occurredAt: Date): DomainEvent =>
  domainEvent(NGO_REGISTERED, occurredAt, {
    ngoId: ngo.id,
    name: ngo.name,
    capacity: ngo.capacity,
  });

export const ngoVerified = (ngo: Ngo, occurredAt: Date): DomainEvent =>
  domainEvent(NGO_VERIFIED, occurredAt, { ngoId: ngo.id });

export const ngoAssigned = (assignment: VillageAssignment, occurredAt: Date): DomainEvent =>
  domainEvent(NGO_ASSIGNED, occurredAt, {
    assignmentId: assignment.id,
    villageId: assignment.villageId,
    ngoId: assignment.ngoId,
  });

export const assignmentReleased = (
  assignment: VillageAssignment,
  occurredAt: Date,
): DomainEvent =>
  domainEvent(ASSIGNMENT_RELEASED, occurredAt, {
    assignmentId: assignment.id,
    villageId: assignment.villageId,
    ngoId: assignment.ngoId,
    reason: assignment.releaseReason,
  });

export const leadershipTeamFormed = (team: LeadershipTeam, occurredAt: Date): DomainEvent =>
  domainEvent(LEADERSHIP_TEAM_FORMED, occurredAt, {
    villageId: team.villageId,
    ngoId: team.ngoId,
    members: team.members.map((m) => ({ role: m.role, personId: m.personId })),
  });
