import { vi } from 'vitest';
import {
  asId,
  ok,
  type AssignmentId,
  type Clock,
  type DomainEvent,
  type IdGenerator,
  type NgoId,
  type PersonId,
  type Result,
  type VillageId,
} from '../../../shared/index.js';
import type { LeadershipTeam } from '../domain/leadership-team.js';
import type { Ngo } from '../domain/ngo.js';
import type { VillageAssignment } from '../domain/village-assignment.js';

/**
 * Mock-driven collaborators for the London-School use-case tests (ADR-004 §2).
 * Every port method is a `vi.fn()` so tests assert *conversations*, not stored state.
 */

export const NOW = new Date('2026-07-28T09:00:00.000Z');

const uuid = (prefix: string, n: number): string =>
  `${prefix}0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const ngoId = (n = 1): NgoId => asId<'NgoId'>(uuid('1', n));
export const villageId = (n = 1): VillageId => asId<'VillageId'>(uuid('2', n));
export const assignmentId = (n = 1): AssignmentId => asId<'AssignmentId'>(uuid('3', n));
export const personId = (n = 1): PersonId => asId<'PersonId'>(uuid('4', n));

export const clockStub = (now: Date = NOW): Clock => ({ now: () => now });

export const idGeneratorStub = (...ids: string[]): IdGenerator => {
  const queue = [...ids];
  const fallback = ids[ids.length - 1] ?? uuid('9', 0);
  return { next: () => queue.shift() ?? fallback };
};

export const eventPublisherMock = () => ({
  publish: vi.fn<(events: readonly DomainEvent[]) => Promise<void>>().mockResolvedValue(undefined),
});

export const ngoRepositoryMock = () => ({
  findById: vi.fn<(id: NgoId) => Promise<Ngo | null>>().mockResolvedValue(null),
  save: vi.fn<(ngo: Ngo) => Promise<void>>().mockResolvedValue(undefined),
});

export const assignmentRepositoryMock = () => ({
  findById: vi
    .fn<(id: AssignmentId) => Promise<VillageAssignment | null>>()
    .mockResolvedValue(null),
  findActiveByVillage: vi
    .fn<(id: VillageId) => Promise<VillageAssignment | null>>()
    .mockResolvedValue(null),
  countActiveByNgo: vi.fn<(id: NgoId) => Promise<number>>().mockResolvedValue(0),
  insertActive: vi
    .fn<(assignment: VillageAssignment) => Promise<Result<void>>>()
    .mockResolvedValue(ok(undefined)),
  save: vi.fn<(assignment: VillageAssignment) => Promise<void>>().mockResolvedValue(undefined),
  findAssignedVillageIds: vi
    .fn<(candidates: readonly VillageId[]) => Promise<readonly VillageId[]>>()
    .mockResolvedValue([]),
});

export const leadershipTeamRepositoryMock = () => ({
  findByVillage: vi
    .fn<(villageId: VillageId) => Promise<LeadershipTeam | null>>()
    .mockResolvedValue(null),
  save: vi.fn<(team: LeadershipTeam) => Promise<void>>().mockResolvedValue(undefined),
});

export const affectedVillageLookupMock = () => ({
  listAffectedVillageIds: vi.fn<() => Promise<readonly VillageId[]>>().mockResolvedValue([]),
});

/** Test data builders — state fed *into* the mocks, never asserted on directly. */
export const anNgo = (overrides: Partial<Ngo> = {}): Ngo => ({
  id: ngoId(1),
  name: 'Assam Relief Trust',
  capacity: 3,
  verified: true,
  ...overrides,
});

export const anAssignment = (overrides: Partial<VillageAssignment> = {}): VillageAssignment => ({
  id: assignmentId(1),
  villageId: villageId(1),
  ngoId: ngoId(1),
  status: 'active',
  assignedAt: NOW,
  releasedAt: null,
  releaseReason: null,
  ...overrides,
});

/** Every event handed to the publisher across all calls, flattened. */
export const publishedEvents = (publisher: ReturnType<typeof eventPublisherMock>): DomainEvent[] =>
  publisher.publish.mock.calls.flatMap((call) => [...(call[0] ?? [])]);
