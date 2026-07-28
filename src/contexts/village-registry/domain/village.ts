import { type Result, type GeoPoint, type VillageId, ok, err } from '../../../shared/index.js';
import { type Demographics } from './demographics.js';
import { type DamageInventory, zeroDamageInventory } from './damage-inventory.js';
import { type Severity, type SeverityChangeRecord, severityChangeRecord } from './severity.js';

/** Village aggregate root (BC-1 Village Registry, PRD §5). */
export interface Village {
  readonly id: VillageId;
  readonly name: string;
  readonly district: string;
  readonly location: GeoPoint;
  readonly demographics: Demographics;
  readonly damageInventory: DamageInventory;
  readonly severity: Severity;
  readonly severityHistory: readonly SeverityChangeRecord[];
  readonly registeredAt: Date;
  readonly updatedAt: Date;
}

export interface CreateVillageProps {
  readonly id: VillageId;
  readonly name: string;
  readonly district: string;
  readonly location: GeoPoint;
  readonly demographics: Demographics;
  readonly at: Date;
}

/**
 * FR-VR-1: registration requires a non-empty name, district and a valid GeoPoint
 * (validity of GeoPoint/Demographics is guaranteed by their own constructors — this
 * function only enforces the invariants specific to registration).
 */
export function createVillage(props: CreateVillageProps): Result<Village> {
  const name = props.name.trim();
  if (name.length === 0) return err('VILLAGE_NAME_REQUIRED', 'village name is required');

  const district = props.district.trim();
  if (district.length === 0) return err('VILLAGE_DISTRICT_REQUIRED', 'village district is required');

  return ok({
    id: props.id,
    name,
    district,
    location: props.location,
    demographics: props.demographics,
    damageInventory: zeroDamageInventory,
    severity: 'unaffected',
    severityHistory: [],
    registeredAt: props.at,
    updatedAt: props.at,
  });
}

/** FR-VR-2: replaces the damage inventory, bumping updatedAt. */
export function applyDamageInventory(village: Village, inventory: DamageInventory, at: Date): Village {
  return { ...village, damageInventory: inventory, updatedAt: at };
}

/** FR-VR-3: transitions severity, appending an audit record; reason is mandatory. */
export function applySeverityChange(
  village: Village,
  to: string,
  reason: string,
  at: Date,
): Result<{ village: Village; record: SeverityChangeRecord }> {
  const recordResult = severityChangeRecord(village.severity, to, reason, at);
  if (!recordResult.ok) return recordResult;

  const record = recordResult.value;
  const updated: Village = {
    ...village,
    severity: record.to,
    severityHistory: [...village.severityHistory, record],
    updatedAt: at,
  };
  return ok({ village: updated, record });
}
