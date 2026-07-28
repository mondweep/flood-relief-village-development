import {
  err,
  ok,
  villageId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { DamageAssessment } from "../domain/village.js";
import type { VillageRepository } from "./ports.js";

export interface RecordDamageAssessmentInput {
  villageId: string;
  assessment: {
    housesDamaged: number;
    schoolsDamaged: number;
    healthCentresDamaged: number;
    waterSourcesDamaged: number;
    agricultureHectaresLost: number;
    livestockLost: number;
    notes?: string;
  };
}

export interface RecordDamageAssessmentOutput {
  villageId: string;
  assessment: DamageAssessment;
}

export interface RecordDamageAssessmentDeps {
  repository: VillageRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class RecordDamageAssessment {
  constructor(private readonly deps: RecordDamageAssessmentDeps) {}

  async execute(input: RecordDamageAssessmentInput): Promise<Result<RecordDamageAssessmentOutput>> {
    const idResult = villageId(input.villageId);
    if (!idResult.ok) return err(idResult.error);

    const village = await this.deps.repository.findById(idResult.value);
    if (!village) return err(`Village not found: ${input.villageId}`);

    const assessedAt = this.deps.clock.now().toISOString();
    const assessmentResult = village.recordDamageAssessment({ ...input.assessment, assessedAt });
    if (!assessmentResult.ok) return err(assessmentResult.error);

    await this.deps.repository.save(village);

    const payload: Record<string, unknown> = { villageId: village.id, assessedAt };
    const event: DomainEvent = {
      name: "village.damage-assessed.v1",
      occurredAt: assessedAt,
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ villageId: village.id, assessment: assessmentResult.value });
  }
}
