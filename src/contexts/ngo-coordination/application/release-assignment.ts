import {
  err,
  ok,
  type AssignmentId,
  type Clock,
  type EventPublisher,
  type Result,
} from '../../../shared/index.js';
import { assignmentReleased } from '../domain/events.js';
import { releaseAssignment } from '../domain/village-assignment.js';
import type { AssignmentRepository } from './ports.js';

export interface ReleaseAssignmentDeps {
  readonly assignments: AssignmentRepository;
  readonly events: EventPublisher;
  readonly clock: Clock;
}

export interface ReleaseAssignmentCommand {
  readonly assignmentId: AssignmentId;
  readonly reason: string;
}

/** FR-NC-3: release an assignment with a reason, freeing the village for reassignment. */
export const releaseAssignmentUseCase =
  (deps: ReleaseAssignmentDeps) =>
  async (command: ReleaseAssignmentCommand): Promise<Result<void>> => {
    const existing = await deps.assignments.findById(command.assignmentId);
    if (!existing) {
      return err('ASSIGNMENT_NOT_FOUND', `no assignment with id ${command.assignmentId}`);
    }

    const released = releaseAssignment(existing, command.reason, deps.clock.now());
    if (!released.ok) return released;

    await deps.assignments.save(released.value);
    await deps.events.publish([assignmentReleased(released.value, deps.clock.now())]);
    return ok(undefined);
  };
