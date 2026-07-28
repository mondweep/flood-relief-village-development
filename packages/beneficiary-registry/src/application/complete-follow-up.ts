import {
  beneficiaryId,
  err,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { BeneficiaryRepository } from "./ports.js";

export interface CompleteFollowUpInput {
  beneficiaryId: string;
  followUpId: string;
}

export interface CompleteFollowUpOutput {
  followUpId: string;
  completedAt: string;
}

export interface CompleteFollowUpDeps {
  repository: BeneficiaryRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class CompleteFollowUp {
  constructor(private readonly deps: CompleteFollowUpDeps) {}

  async execute(input: CompleteFollowUpInput): Promise<Result<CompleteFollowUpOutput>> {
    const idResult = beneficiaryId(input.beneficiaryId);
    if (!idResult.ok) return err(idResult.error);

    const beneficiary = await this.deps.repository.findById(idResult.value);
    if (!beneficiary) return err(`beneficiary not found: ${input.beneficiaryId}`);

    const completedAt = this.deps.clock.now().toISOString();
    const completed = beneficiary.completeFollowUp(input.followUpId, completedAt);
    if (!completed.ok) return err(completed.error);

    await this.deps.repository.save(beneficiary);

    const event: DomainEvent = {
      name: "beneficiary.follow-up-completed.v1",
      occurredAt: completedAt,
      payload: {
        beneficiaryId: beneficiary.id,
        followUpId: completed.value.id,
        completedAt,
      },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ followUpId: completed.value.id, completedAt });
  }
}
