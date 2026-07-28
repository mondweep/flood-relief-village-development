import {
  beneficiaryId,
  err,
  ok,
  villageId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";
import { Beneficiary, type BeneficiaryCategory } from "../domain/beneficiary.js";
import type { BeneficiaryRepository } from "./ports.js";

export interface RegisterBeneficiaryInput {
  villageId: string;
  name: string;
  category: BeneficiaryCategory;
}

export interface RegisterBeneficiaryOutput {
  beneficiaryId: string;
}

export interface RegisterBeneficiaryDeps {
  repository: BeneficiaryRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class RegisterBeneficiary {
  constructor(private readonly deps: RegisterBeneficiaryDeps) {}

  async execute(input: RegisterBeneficiaryInput): Promise<Result<RegisterBeneficiaryOutput>> {
    const villageIdResult = villageId(input.villageId);
    if (!villageIdResult.ok) return err(villageIdResult.error);

    const idResult = beneficiaryId(this.deps.idGenerator.next());
    if (!idResult.ok) return err(idResult.error);

    const beneficiaryResult = Beneficiary.create({
      id: idResult.value,
      villageId: villageIdResult.value,
      name: input.name,
      category: input.category,
    });
    if (!beneficiaryResult.ok) return err(beneficiaryResult.error);

    const beneficiary = beneficiaryResult.value;
    await this.deps.repository.save(beneficiary);

    const event: DomainEvent = {
      name: "beneficiary.registered.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload: {
        beneficiaryId: beneficiary.id,
        villageId: beneficiary.villageId,
        category: beneficiary.category,
      },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ beneficiaryId: beneficiary.id });
  }
}
