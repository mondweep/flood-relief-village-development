import { err, ok, villageId as toVillageId, type Clock, type EventPublisher, type Result } from "@afrip/shared-kernel";
import type { CommitteeRole } from "../domain/village-assignment.js";
import type { AssignmentRepository } from "./ports.js";

export interface AddCommitteeMemberDeps {
  assignmentRepository: AssignmentRepository;
  eventPublisher: EventPublisher;
  clock: Clock;
}

export interface AddCommitteeMemberInput {
  villageId: string;
  role: CommitteeRole;
  name: string;
  contact?: string;
}

export interface AddCommitteeMemberOutput {
  assignmentId: string;
}

export class AddCommitteeMember {
  constructor(private readonly deps: AddCommitteeMemberDeps) {}

  async execute(input: AddCommitteeMemberInput): Promise<Result<AddCommitteeMemberOutput>> {
    const villageIdResult = toVillageId(input.villageId);
    if (!villageIdResult.ok) return err(villageIdResult.error);

    const assignment = await this.deps.assignmentRepository.findActiveByVillage(villageIdResult.value);
    if (!assignment) return err("no active assignment for village");

    const addResult = assignment.addCommitteeMember({
      role: input.role,
      name: input.name,
      contact: input.contact,
    });
    if (!addResult.ok) return err(addResult.error);

    await this.deps.assignmentRepository.save(assignment);

    await this.deps.eventPublisher.publish([
      {
        name: "committee-member.added.v1",
        occurredAt: this.deps.clock.now().toISOString(),
        payload: { assignmentId: assignment.id, role: input.role },
      },
    ]);

    return ok({ assignmentId: assignment.id });
  }
}
