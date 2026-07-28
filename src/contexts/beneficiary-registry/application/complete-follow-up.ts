import { type BeneficiaryId, type Clock, type EventPublisher, type Result, asId, err, isUuid, ok } from '../../../shared/index.js';
import { DEFAULT_FOLLOW_UP_INTERVAL_DAYS } from '../domain/follow-up.js';
import { followUpCompleted } from '../domain/events.js';
import type { BeneficiaryRepository } from './ports.js';

export interface CompleteFollowUpInput {
  readonly beneficiaryId: string;
}

export interface CompleteFollowUpOutput {
  readonly nextFollowUpAt: Date | undefined;
}

/** FR-BR-4: completing a follow-up schedules the next one for mandatory categories. */
export class CompleteFollowUp {
  constructor(
    private readonly repository: BeneficiaryRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly intervalDays: number = DEFAULT_FOLLOW_UP_INTERVAL_DAYS,
  ) {}

  async execute(input: CompleteFollowUpInput): Promise<Result<CompleteFollowUpOutput>> {
    if (!isUuid(input.beneficiaryId)) {
      return err('BENEFICIARY_INVALID_ID', `invalid beneficiary id: ${input.beneficiaryId}`);
    }
    const beneficiaryId: BeneficiaryId = asId<'BeneficiaryId'>(input.beneficiaryId);

    const beneficiary = await this.repository.findById(beneficiaryId);
    if (!beneficiary) return err('BENEFICIARY_NOT_FOUND', `no beneficiary with id: ${input.beneficiaryId}`);

    const completedAt = this.clock.now();
    const updated = beneficiary.completeFollowUp(completedAt, this.intervalDays);
    await this.repository.save(updated);

    await this.publisher.publish([followUpCompleted(beneficiaryId, completedAt, updated.nextFollowUpAt)]);

    return ok({ nextFollowUpAt: updated.nextFollowUpAt });
  }
}
