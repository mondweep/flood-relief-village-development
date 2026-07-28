import {
  type BeneficiaryId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
  asId,
  err,
  isUuid,
  ok,
} from '../../../shared/index.js';
import { aidEvent } from '../domain/aid-event.js';
import { DEFAULT_SUSPICION_WINDOW_DAYS } from '../domain/beneficiary.js';
import { aidRecorded, duplicateAidSuspected } from '../domain/events.js';
import type { BeneficiaryRepository } from './ports.js';

export interface RecordAidInput {
  readonly beneficiaryId: string;
  readonly kind: string;
  readonly providerName: string;
  readonly note?: string;
}

export interface RecordAidOutput {
  readonly duplicateSuspected: boolean;
}

/** FR-BR-2 (append-only aid history) + FR-BR-3 (duplicate suspicion within a window). */
export class RecordAid {
  constructor(
    private readonly repository: BeneficiaryRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly suspicionWindowDays: number = DEFAULT_SUSPICION_WINDOW_DAYS,
  ) {}

  async execute(input: RecordAidInput): Promise<Result<RecordAidOutput>> {
    if (!isUuid(input.beneficiaryId)) {
      return err('BENEFICIARY_INVALID_ID', `invalid beneficiary id: ${input.beneficiaryId}`);
    }
    const beneficiaryId: BeneficiaryId = asId<'BeneficiaryId'>(input.beneficiaryId);

    const beneficiary = await this.repository.findById(beneficiaryId);
    if (!beneficiary) return err('BENEFICIARY_NOT_FOUND', `no beneficiary with id: ${input.beneficiaryId}`);

    const at = this.clock.now();
    const built = aidEvent(input.kind, input.providerName, at, input.note);
    if (!built.ok) return built;

    const { beneficiary: updated, duplicateOf } = beneficiary.recordAid(built.value, this.suspicionWindowDays);
    await this.repository.save(updated);

    const events: DomainEvent[] = [aidRecorded(beneficiaryId, built.value, at)];
    if (duplicateOf) {
      events.push(duplicateAidSuspected(beneficiaryId, built.value, duplicateOf, at));
    }
    await this.publisher.publish(events);

    return ok({ duplicateSuspected: duplicateOf !== undefined });
  }
}
