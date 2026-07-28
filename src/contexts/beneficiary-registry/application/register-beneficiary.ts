import {
  type BeneficiaryId,
  type Clock,
  type EventPublisher,
  type Result,
  type VillageId,
  asId,
  err,
  isUuid,
  ok,
} from '../../../shared/index.js';
import { Beneficiary } from '../domain/beneficiary.js';
import { beneficiaryRegistered } from '../domain/events.js';
import { isVulnerabilityCategory, type VulnerabilityCategory } from '../domain/vulnerability-category.js';
import type { BeneficiaryRepository } from './ports.js';

export interface RegisterBeneficiaryInput {
  readonly id: string;
  readonly villageId: string;
  readonly categories: readonly string[];
}

export interface RegisterBeneficiaryOutput {
  readonly beneficiaryId: BeneficiaryId;
}

/** FR-BR-1: register a beneficiary with >=1 vulnerability category and a village. */
export class RegisterBeneficiary {
  constructor(
    private readonly repository: BeneficiaryRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async execute(input: RegisterBeneficiaryInput): Promise<Result<RegisterBeneficiaryOutput>> {
    if (!isUuid(input.id)) return err('BENEFICIARY_INVALID_ID', `invalid beneficiary id: ${input.id}`);
    if (!isUuid(input.villageId)) return err('BENEFICIARY_INVALID_VILLAGE_ID', `invalid village id: ${input.villageId}`);

    const categories: VulnerabilityCategory[] = [];
    for (const category of input.categories) {
      if (!isVulnerabilityCategory(category)) {
        return err('BENEFICIARY_INVALID_CATEGORY', `unknown vulnerability category: ${category}`);
      }
      categories.push(category);
    }

    const beneficiaryId = asId<'BeneficiaryId'>(input.id);
    const villageId = asId<'VillageId'>(input.villageId);
    const registeredAt = this.clock.now();

    const registration = Beneficiary.register({ id: beneficiaryId, villageId, categories, registeredAt });
    if (!registration.ok) return registration;

    await this.repository.save(registration.value);
    await this.publisher.publish([beneficiaryRegistered(beneficiaryId, villageId, categories, registeredAt)]);

    return ok({ beneficiaryId });
  }
}
