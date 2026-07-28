import { describe, expect, it } from 'vitest';
import { asId, type IssueId, type VillageId } from '../../../shared/index.js';
import { districtDepartmentRouting } from './routing-decision.js';
import {
  issueRejectedEvent,
  issueReportedEvent,
  issueResolvedEvent,
  issueRoutedEvent,
} from './issue-events.js';

// Pure event builders: state-based tests are appropriate here (ADR-004 §5).
describe('Issue domain events', () => {
  const issueId = asId<'IssueId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as IssueId;
  const villageId = asId<'VillageId'>('4a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d') as VillageId;
  const occurredAt = new Date('2026-07-28T09:00:00Z');

  it('builds IssueReported with issueId, villageId, category', () => {
    const event = issueReportedEvent({ issueId, villageId, category: 'water' }, occurredAt);
    expect(event.type).toBe('IssueReported');
    expect(event.occurredAt).toBe(occurredAt);
    expect(event.payload).toEqual({ issueId, villageId, category: 'water' });
  });

  it('builds IssueRouted with issueId and routingDecision', () => {
    const routingDecision = districtDepartmentRouting('district_administration');
    const event = issueRoutedEvent({ issueId, routingDecision }, occurredAt);
    expect(event.type).toBe('IssueRouted');
    expect(event.payload).toEqual({ issueId, routingDecision });
  });

  it('builds IssueResolved with issueId', () => {
    const event = issueResolvedEvent({ issueId }, occurredAt);
    expect(event.type).toBe('IssueResolved');
    expect(event.payload).toEqual({ issueId });
  });

  it('builds IssueRejected with issueId and reason', () => {
    const event = issueRejectedEvent({ issueId, reason: 'duplicate' }, occurredAt);
    expect(event.type).toBe('IssueRejected');
    expect(event.payload).toEqual({ issueId, reason: 'duplicate' });
  });
});
