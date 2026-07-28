import {
  err,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
  type VillageId,
  type VolunteerId,
} from "@afrip/shared-kernel";
import type { Assignment } from "../domain/volunteer.js";
import type { VolunteerRepository } from "./ports.js";

export interface AssignVolunteerInput {
  volunteerId: VolunteerId;
  villageId: VillageId;
  task: string;
}

export interface AssignVolunteerOutput {
  assignmentId: string;
  volunteerId: string;
}

export interface AssignVolunteerDeps {
  repository: VolunteerRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class AssignVolunteer {
  constructor(private readonly deps: AssignVolunteerDeps) {}

  async execute(input: AssignVolunteerInput): Promise<Result<AssignVolunteerOutput>> {
    const volunteer = await this.deps.repository.findById(input.volunteerId);
    if (!volunteer) return err("volunteer not found");

    if (!volunteer.canBeAssigned()) {
      return err("volunteer is not available");
    }

    const assignmentId = this.deps.idGenerator.next();
    const assignment: Assignment = {
      id: assignmentId,
      villageId: input.villageId,
      task: input.task,
      assignedAt: this.deps.clock.now().toISOString(),
      hours: 0,
    };

    volunteer.addAssignment(assignment);
    await this.deps.repository.save(volunteer);

    const payload: Record<string, unknown> = {
      volunteerId: volunteer.id,
      villageId: input.villageId,
      task: input.task,
      assignmentId,
    };
    const event: DomainEvent = {
      name: "volunteer.assigned.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ assignmentId, volunteerId: volunteer.id });
  }
}
