import { type BeneficiaryId, type DomainEvent, type VillageId, domainEvent } from '../../../shared/index.js';
import type { AidEvent } from './aid-event.js';
import type { VulnerabilityCategory } from './vulnerability-category.js';

/** FR-BR-1: raised on successful registration. */
export function beneficiaryRegistered(
  beneficiaryId: BeneficiaryId,
  villageId: VillageId,
  categories: readonly VulnerabilityCategory[],
  occurredAt: Date,
): DomainEvent {
  return domainEvent('BeneficiaryRegistered', occurredAt, { beneficiaryId, villageId, categories });
}

/** FR-BR-2: raised every time an aid event is appended, duplicate or not. */
export function aidRecorded(beneficiaryId: BeneficiaryId, aid: AidEvent, occurredAt: Date): DomainEvent {
  return domainEvent('AidRecorded', occurredAt, { beneficiaryId, aid });
}

/** FR-BR-3: raised in addition to AidRecorded when a same-kind aid falls within the suspicion window. */
export function duplicateAidSuspected(
  beneficiaryId: BeneficiaryId,
  newAid: AidEvent,
  existingAid: AidEvent,
  occurredAt: Date,
): DomainEvent {
  return domainEvent('DuplicateAidSuspected', occurredAt, { beneficiaryId, newAid, existingAid });
}

/** FR-BR-4: raised when a follow-up is completed; carries the next scheduled date, if any. */
export function followUpCompleted(
  beneficiaryId: BeneficiaryId,
  completedAt: Date,
  nextFollowUpAt: Date | undefined,
): DomainEvent {
  return domainEvent('FollowUpCompleted', completedAt, {
    beneficiaryId,
    completedAt,
    ...(nextFollowUpAt !== undefined ? { nextFollowUpAt } : {}),
  });
}
