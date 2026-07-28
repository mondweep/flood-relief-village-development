import { type DomainEvent, domainEvent } from '../../../shared/index.js';
import type { Village } from './village.js';
import type { SeverityChangeRecord } from './severity.js';

/** FR-VR-1: emitted when a village is first registered. */
export function villageRegistered(village: Village, at: Date): DomainEvent {
  return domainEvent('VillageRegistered', at, {
    villageId: village.id,
    name: village.name,
    district: village.district,
    location: village.location,
    demographics: village.demographics,
  });
}

/** FR-VR-2: emitted when a village's profile (damage inventory) is updated. */
export function profileUpdated(village: Village, at: Date): DomainEvent {
  return domainEvent('ProfileUpdated', at, {
    villageId: village.id,
    damageInventory: village.damageInventory,
  });
}

/** FR-VR-3: emitted when a village's severity changes. */
export function severityChanged(village: Village, record: SeverityChangeRecord, at: Date): DomainEvent {
  return domainEvent('SeverityChanged', at, {
    villageId: village.id,
    from: record.from,
    to: record.to,
    reason: record.reason,
  });
}
