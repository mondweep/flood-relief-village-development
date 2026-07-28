import {
  assignmentId as toAssignmentId,
  err,
  ngoId as toNgoId,
  ok,
  villageId as toVillageId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";
import { VillageAssignment } from "../domain/village-assignment.js";
import type { AssignmentRepository, NgoRepository } from "./ports.js";

export interface AssignNgoToVillageDeps {
  ngoRepository: NgoRepository;
  assignmentRepository: AssignmentRepository;
  idGenerator: IdGenerator;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export interface AssignNgoToVillageInput {
  villageId: string;
  ngoId: string;
}

export interface AssignNgoToVillageOutput {
  assignmentId: string;
}

export class AssignNgoToVillage {
  constructor(private readonly deps: AssignNgoToVillageDeps) {}

  async execute(input: AssignNgoToVillageInput): Promise<Result<AssignNgoToVillageOutput>> {
    const villageIdResult = toVillageId(input.villageId);
    if (!villageIdResult.ok) return err(villageIdResult.error);
    const ngoIdResult = toNgoId(input.ngoId);
    if (!ngoIdResult.ok) return err(ngoIdResult.error);

    const villageId = villageIdResult.value;
    const ngoId = ngoIdResult.value;

    const ngo = await this.deps.ngoRepository.findById(ngoId);
    if (!ngo) return err("NGO not found");

    const activeForNgo = await this.deps.assignmentRepository.findActiveByNgo(ngoId);
    if (activeForNgo.length >= ngo.capacity) return err("capacity exceeded");

    const events: DomainEvent[] = [];

    const previous = await this.deps.assignmentRepository.findActiveByVillage(villageId);
    if (previous) {
      const retireResult = previous.retire();
      if (!retireResult.ok) return err(retireResult.error);
      await this.deps.assignmentRepository.save(previous);
      events.push({
        name: "assignment.retired.v1",
        occurredAt: this.deps.clock.now().toISOString(),
        payload: { assignmentId: previous.id, villageId: previous.villageId, ngoId: previous.ngoId },
      });
    }

    const assignmentIdResult = toAssignmentId(this.deps.idGenerator.next());
    if (!assignmentIdResult.ok) return err(assignmentIdResult.error);

    const assignment = VillageAssignment.create({
      id: assignmentIdResult.value,
      villageId,
      ngoId,
      assignedAt: this.deps.clock.now().toISOString(),
    });

    await this.deps.assignmentRepository.save(assignment);

    events.push({
      name: "ngo.assigned-to-village.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload: { assignmentId: assignment.id, villageId: assignment.villageId, ngoId: assignment.ngoId },
    });

    await this.deps.eventPublisher.publish(events);

    return ok({ assignmentId: assignment.id });
  }
}
