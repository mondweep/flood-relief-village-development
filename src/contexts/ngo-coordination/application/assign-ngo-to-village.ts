import {
  asId,
  err,
  ok,
  type AssignmentId,
  type Clock,
  type EventPublisher,
  type IdGenerator,
  type NgoId,
  type Result,
  type VillageId,
} from '../../../shared/index.js';
import { ngoAssigned } from '../domain/events.js';
import { hasCapacityFor } from '../domain/ngo.js';
import { createAssignment } from '../domain/village-assignment.js';
import type { AssignmentRepository, NgoRepository } from './ports.js';

export interface AssignNgoToVillageDeps {
  readonly ngos: NgoRepository;
  readonly assignments: AssignmentRepository;
  readonly events: EventPublisher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface AssignNgoToVillageCommand {
  readonly villageId: VillageId;
  readonly ngoId: NgoId;
}

export interface AssignNgoToVillageResult {
  readonly assignmentId: AssignmentId;
}

/**
 * FR-NC-2 (one active NGO per village, verified NGOs only) and FR-NC-4 (capacity).
 * Nothing is written until every invariant holds; the final guarded insert closes the
 * read-then-write race (see `AssignmentRepository.insertActive`).
 */
export const assignNgoToVillageUseCase =
  (deps: AssignNgoToVillageDeps) =>
  async (command: AssignNgoToVillageCommand): Promise<Result<AssignNgoToVillageResult>> => {
    const ngo = await deps.ngos.findById(command.ngoId);
    if (!ngo) {
      return err('NGO_NOT_FOUND', `no NGO with id ${command.ngoId}`);
    }
    if (!ngo.verified) {
      return err('NGO_NOT_VERIFIED', `NGO ${ngo.id} must be verified before it can be assigned`);
    }

    const active = await deps.assignments.findActiveByVillage(command.villageId);
    if (active) {
      return err(
        'VILLAGE_ALREADY_ASSIGNED',
        `village ${command.villageId} already has an active NGO assignment`,
      );
    }

    const activeCount = await deps.assignments.countActiveByNgo(command.ngoId);
    if (!hasCapacityFor(ngo, activeCount)) {
      return err(
        'NGO_AT_CAPACITY',
        `NGO ${ngo.id} already leads ${activeCount} of ${ngo.capacity} villages`,
      );
    }

    const assignment = createAssignment({
      id: asId<'AssignmentId'>(deps.ids.next()),
      villageId: command.villageId,
      ngoId: command.ngoId,
      assignedAt: deps.clock.now(),
    });

    const inserted = await deps.assignments.insertActive(assignment);
    if (!inserted.ok) return inserted;

    await deps.events.publish([ngoAssigned(assignment, deps.clock.now())]);
    return ok({ assignmentId: assignment.id });
  };
