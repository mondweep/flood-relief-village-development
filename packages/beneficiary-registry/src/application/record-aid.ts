import {
  beneficiaryId,
  err,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { AidType, ProviderType } from "../domain/beneficiary.js";
import type { BeneficiaryRepository } from "./ports.js";

export interface RecordAidInput {
  beneficiaryId: string;
  aidType: AidType;
  providerId: string;
  providerType: ProviderType;
  notes?: string;
}

export interface RecordAidOutput {
  beneficiaryId: string;
  deliveredAt: string;
  /** True when a duplicate-aid flag was raised alongside the recording. */
  duplicate: boolean;
}

export interface RecordAidDeps {
  repository: BeneficiaryRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
  /** Duplicate-detection window in days; defaults to the domain's 14 days. */
  windowDays?: number;
}

export class RecordAid {
  constructor(private readonly deps: RecordAidDeps) {}

  async execute(input: RecordAidInput): Promise<Result<RecordAidOutput>> {
    const idResult = beneficiaryId(input.beneficiaryId);
    if (!idResult.ok) return err(idResult.error);

    const beneficiary = await this.deps.repository.findById(idResult.value);
    if (!beneficiary) return err(`beneficiary not found: ${input.beneficiaryId}`);

    const deliveredAt = this.deps.clock.now().toISOString();
    const outcome = beneficiary.recordAid({
      aidType: input.aidType,
      providerId: input.providerId,
      providerType: input.providerType,
      deliveredAt,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(this.deps.windowDays === undefined ? {} : { windowDays: this.deps.windowDays }),
    });
    if (!outcome.ok) return err(outcome.error);

    await this.deps.repository.save(beneficiary);

    const occurredAt = this.deps.clock.now().toISOString();
    const events: DomainEvent[] = [
      {
        name: "beneficiary.aid-recorded.v1",
        occurredAt,
        payload: {
          beneficiaryId: beneficiary.id,
          aidType: outcome.value.record.aidType,
          providerId: outcome.value.record.providerId,
          providerType: outcome.value.record.providerType,
          deliveredAt: outcome.value.record.deliveredAt,
        },
      },
    ];
    const flag = outcome.value.duplicateFlag;
    if (flag) {
      events.push({
        name: "beneficiary.duplicate-aid-flagged.v1",
        occurredAt,
        payload: {
          beneficiaryId: beneficiary.id,
          aidType: flag.aidType,
          providerIds: [...flag.providerIds],
        },
      });
    }
    await this.deps.eventPublisher.publish(events);

    return ok({ beneficiaryId: beneficiary.id, deliveredAt, duplicate: flag !== null });
  }
}
