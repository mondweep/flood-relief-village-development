import {
  beneficiaryId,
  err,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";
import type { BeneficiaryRepository } from "./ports.js";

export interface ScheduleFollowUpInput {
  beneficiaryId: string;
  dueAt: string;
}

export interface ScheduleFollowUpOutput {
  followUpId: string;
}

export interface ScheduleFollowUpDeps {
  repository: BeneficiaryRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class ScheduleFollowUp {
  constructor(private readonly deps: ScheduleFollowUpDeps) {}

  async execute(input: ScheduleFollowUpInput): Promise<Result<ScheduleFollowUpOutput>> {
    const idResult = beneficiaryId(input.beneficiaryId);
    if (!idResult.ok) return err(idResult.error);

    const beneficiary = await this.deps.repository.findById(idResult.value);
    if (!beneficiary) return err(`beneficiary not found: ${input.beneficiaryId}`);

    const followUpId = this.deps.idGenerator.next();
    const scheduled = beneficiary.scheduleFollowUp(followUpId, input.dueAt);
    if (!scheduled.ok) return err(scheduled.error);

    await this.deps.repository.save(beneficiary);

    const event: DomainEvent = {
      name: "beneficiary.follow-up-scheduled.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload: {
        beneficiaryId: beneficiary.id,
        followUpId: scheduled.value.id,
        dueAt: scheduled.value.dueAt,
      },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ followUpId: scheduled.value.id });
  }
}
