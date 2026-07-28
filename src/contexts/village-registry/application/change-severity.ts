import { type Result, type Clock, type EventPublisher, type VillageId, ok, err } from '../../../shared/index.js';
import { type Village, applySeverityChange } from '../domain/village.js';
import type { Severity } from '../domain/severity.js';
import { severityChanged } from '../domain/events.js';
import type { VillageRepository } from './ports.js';

/** FR-VR-3: change severity with reason, keeping full audit history. */
export interface ChangeSeverityInput {
  readonly villageId: VillageId;
  readonly to: Severity;
  readonly reason: string;
}

export interface ChangeSeverityDeps {
  readonly repository: VillageRepository;
  readonly publisher: EventPublisher;
  readonly clock: Clock;
}

export async function changeSeverity(input: ChangeSeverityInput, deps: ChangeSeverityDeps): Promise<Result<Village>> {
  const village = await deps.repository.findById(input.villageId);
  if (!village) return err('VILLAGE_NOT_FOUND', `no village with id ${input.villageId}`);

  const at = deps.clock.now();
  const result = applySeverityChange(village, input.to, input.reason, at);
  if (!result.ok) return result;

  const { village: updated, record } = result.value;
  await deps.repository.save(updated);
  await deps.publisher.publish([severityChanged(updated, record, at)]);
  return ok(updated);
}
