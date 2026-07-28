import { type Result, type Clock, type EventPublisher, type VillageId, ok, err } from '../../../shared/index.js';
import { type Village, applyDamageInventory } from '../domain/village.js';
import { damageInventory, type DamageInventoryInput } from '../domain/damage-inventory.js';
import { profileUpdated } from '../domain/events.js';
import type { VillageRepository } from './ports.js';

/** FR-VR-2: update the damage inventory with non-negative counts. */
export interface UpdateDamageInventoryInput {
  readonly villageId: VillageId;
  readonly damageInventory: DamageInventoryInput;
}

export interface UpdateDamageInventoryDeps {
  readonly repository: VillageRepository;
  readonly publisher: EventPublisher;
  readonly clock: Clock;
}

export async function updateDamageInventory(
  input: UpdateDamageInventoryInput,
  deps: UpdateDamageInventoryDeps,
): Promise<Result<Village>> {
  const village = await deps.repository.findById(input.villageId);
  if (!village) return err('VILLAGE_NOT_FOUND', `no village with id ${input.villageId}`);

  const inventoryResult = damageInventory(input.damageInventory);
  if (!inventoryResult.ok) return inventoryResult;

  const at = deps.clock.now();
  const updated = applyDamageInventory(village, inventoryResult.value, at);

  await deps.repository.save(updated);
  await deps.publisher.publish([profileUpdated(updated, at)]);
  return ok(updated);
}
