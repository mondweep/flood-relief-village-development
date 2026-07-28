import {
  err,
  ok,
  villageId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { Severity } from "../domain/village.js";
import type { VillageRepository } from "./ports.js";

export interface UpdateSeverityInput {
  villageId: string;
  severity: Severity;
}

export interface UpdateSeverityOutput {
  villageId: string;
  severity: Severity;
  previous: Severity;
}

export interface UpdateSeverityDeps {
  repository: VillageRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class UpdateSeverity {
  constructor(private readonly deps: UpdateSeverityDeps) {}

  async execute(input: UpdateSeverityInput): Promise<Result<UpdateSeverityOutput>> {
    const idResult = villageId(input.villageId);
    if (!idResult.ok) return err(idResult.error);

    const village = await this.deps.repository.findById(idResult.value);
    if (!village) return err(`Village not found: ${input.villageId}`);

    const updateResult = village.updateSeverity(input.severity);
    if (!updateResult.ok) return err(updateResult.error);

    await this.deps.repository.save(village);

    const payload: Record<string, unknown> = {
      villageId: village.id,
      severity: village.severity,
      previous: updateResult.value.previous,
    };
    const event: DomainEvent = {
      name: "village.severity-updated.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ villageId: village.id, severity: village.severity, previous: updateResult.value.previous });
  }
}
