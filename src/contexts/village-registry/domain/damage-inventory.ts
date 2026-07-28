import { type Result, ok, err } from '../../../shared/index.js';

/** Damage inventory value object (FR-VR-2): counts must be non-negative. */
export interface DamageInventory {
  readonly houses: number;
  readonly schools: number;
  readonly healthCentres: number;
  readonly waterSources: number;
  readonly agricultureHectares: number;
  readonly livestock: number;
}

export type DamageInventoryInput = DamageInventory;

const FIELDS = [
  'houses',
  'schools',
  'healthCentres',
  'waterSources',
  'agricultureHectares',
  'livestock',
] as const satisfies readonly (keyof DamageInventory)[];

export function damageInventory(input: DamageInventoryInput): Result<DamageInventory> {
  for (const field of FIELDS) {
    const value = input[field];
    if (!Number.isFinite(value) || value < 0) {
      return err('DAMAGE_INVENTORY_NEGATIVE', `${field} must be a non-negative number, got ${value}`);
    }
  }
  return ok({
    houses: input.houses,
    schools: input.schools,
    healthCentres: input.healthCentres,
    waterSources: input.waterSources,
    agricultureHectares: input.agricultureHectares,
    livestock: input.livestock,
  });
}

/** Every village starts with a zero damage inventory until FR-VR-2 updates it. */
export const zeroDamageInventory: DamageInventory = {
  houses: 0,
  schools: 0,
  healthCentres: 0,
  waterSources: 0,
  agricultureHectares: 0,
  livestock: 0,
};
