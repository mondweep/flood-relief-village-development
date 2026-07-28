import {
  err,
  ok,
  type AssignmentId,
  type NgoId,
  type Result,
  type VillageId,
} from '../../../shared/index.js';

export type AssignmentStatus = 'active' | 'released';

/**
 * BC-2 aggregate root for the One Village, One NGO binding (FR-NC-2/3).
 * At most one assignment per village may be `active` at any time — that invariant spans
 * aggregates, so it is enforced by the use case plus a repository uniqueness guarantee.
 */
export interface VillageAssignment {
  readonly id: AssignmentId;
  readonly villageId: VillageId;
  readonly ngoId: NgoId;
  readonly status: AssignmentStatus;
  readonly assignedAt: Date;
  readonly releasedAt: Date | null;
  readonly releaseReason: string | null;
}

export interface CreateAssignmentInput {
  readonly id: AssignmentId;
  readonly villageId: VillageId;
  readonly ngoId: NgoId;
  readonly assignedAt: Date;
}

/** FR-NC-2: a new assignment always starts active with no release information. */
export function createAssignment(input: CreateAssignmentInput): VillageAssignment {
  return {
    id: input.id,
    villageId: input.villageId,
    ngoId: input.ngoId,
    status: 'active',
    assignedAt: input.assignedAt,
    releasedAt: null,
    releaseReason: null,
  };
}

export const isActive = (assignment: VillageAssignment): boolean =>
  assignment.status === 'active';

/** FR-NC-3: releasing requires a reason and only applies to an active assignment. */
export function releaseAssignment(
  assignment: VillageAssignment,
  reason: string,
  releasedAt: Date,
): Result<VillageAssignment> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return err('RELEASE_REASON_REQUIRED', 'releasing an assignment requires a reason');
  }
  if (!isActive(assignment)) {
    return err(
      'ASSIGNMENT_NOT_ACTIVE',
      `assignment ${assignment.id} is already released and cannot be released again`,
    );
  }
  return ok({ ...assignment, status: 'released', releasedAt, releaseReason: trimmed });
}
