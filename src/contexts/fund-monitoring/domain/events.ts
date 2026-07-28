/**
 * Domain events published by Fund Monitoring (PRD §4.3, §5 BC-4).
 * Payloads are flat and primitive so the outbox can serialise them verbatim.
 */
import { type DomainEvent, type Money, domainEvent } from '../../../shared/index.js';
import type { Anomaly } from './anomaly-detector.js';
import { totalReleased, totalSpent } from './budget-ledger.js';
import type { EvidenceItem } from './evidence.js';
import type { FundedProject } from './funded-project.js';
import { FUND_EVENT_TYPES } from './types.js';

export const projectFunded = (project: FundedProject, at: Date): DomainEvent =>
  domainEvent(FUND_EVENT_TYPES.projectFunded, at, {
    projectId: project.id,
    villageId: project.villageId,
    title: project.title,
    category: project.category,
    fundingSource: project.fundingSource,
    sanctionedMinor: project.ledger.sanctioned.amountMinor,
    currency: project.ledger.sanctioned.currency,
    expectedCompletionAt: project.expectedCompletionAt.toISOString(),
  });

export const fundsReleased = (project: FundedProject, amount: Money, at: Date): DomainEvent =>
  domainEvent(FUND_EVENT_TYPES.fundsReleased, at, {
    projectId: project.id,
    villageId: project.villageId,
    amountMinor: amount.amountMinor,
    currency: amount.currency,
    totalReleasedMinor: totalReleased(project.ledger).amountMinor,
    sanctionedMinor: project.ledger.sanctioned.amountMinor,
  });

export const expenditureRecorded = (
  project: FundedProject,
  amount: Money,
  description: string,
  at: Date,
): DomainEvent =>
  domainEvent(FUND_EVENT_TYPES.expenditureRecorded, at, {
    projectId: project.id,
    villageId: project.villageId,
    amountMinor: amount.amountMinor,
    currency: amount.currency,
    description,
    totalSpentMinor: totalSpent(project.ledger).amountMinor,
    totalReleasedMinor: totalReleased(project.ledger).amountMinor,
  });

export const evidenceAttached = (
  project: FundedProject,
  item: EvidenceItem,
  at: Date,
): DomainEvent =>
  domainEvent(FUND_EVENT_TYPES.evidenceAttached, at, {
    projectId: project.id,
    villageId: project.villageId,
    kind: item.kind,
    uri: item.uri,
    attachedBy: item.attachedBy,
    ...(item.location === undefined ? {} : { lat: item.location.lat, lng: item.location.lng }),
  });

export const projectCompleted = (project: FundedProject, at: Date): DomainEvent =>
  domainEvent(FUND_EVENT_TYPES.projectCompleted, at, {
    projectId: project.id,
    villageId: project.villageId,
    category: project.category,
    totalSpentMinor: totalSpent(project.ledger).amountMinor,
    currency: project.ledger.sanctioned.currency,
    completedAt: at.toISOString(),
  });

export const anomalyFlagged = (anomaly: Anomaly, at: Date): DomainEvent =>
  domainEvent(FUND_EVENT_TYPES.anomalyFlagged, at, {
    projectId: anomaly.projectId,
    kind: anomaly.kind,
    details: anomaly.details,
  });
