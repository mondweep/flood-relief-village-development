import { domainEvent, type DomainEvent, type IssueId, type VillageId } from '../../../shared/index.js';
import type { IssueCategory } from './issue-category.js';
import type { RoutingDecision } from './routing-decision.js';

/**
 * BC-6 Issue Tracking — domain events (PRD §4.3, §5 BC-6).
 * Pure builders; use cases call these and hand the result to EventPublisher.
 */
export function issueReportedEvent(
  params: { readonly issueId: IssueId; readonly villageId: VillageId; readonly category: IssueCategory },
  occurredAt: Date,
): DomainEvent {
  return domainEvent('IssueReported', occurredAt, {
    issueId: params.issueId,
    villageId: params.villageId,
    category: params.category,
  });
}

export function issueRoutedEvent(
  params: { readonly issueId: IssueId; readonly routingDecision: RoutingDecision },
  occurredAt: Date,
): DomainEvent {
  return domainEvent('IssueRouted', occurredAt, {
    issueId: params.issueId,
    routingDecision: params.routingDecision,
  });
}

export function issueResolvedEvent(params: { readonly issueId: IssueId }, occurredAt: Date): DomainEvent {
  return domainEvent('IssueResolved', occurredAt, { issueId: params.issueId });
}

export function issueRejectedEvent(
  params: { readonly issueId: IssueId; readonly reason: string },
  occurredAt: Date,
): DomainEvent {
  return domainEvent('IssueRejected', occurredAt, { issueId: params.issueId, reason: params.reason });
}
