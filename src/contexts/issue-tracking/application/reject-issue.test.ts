import { describe, expect, it, vi } from 'vitest';
import { asId, unwrap, type Clock, type EventPublisher, type IssueId, type VillageId } from '../../../shared/index.js';
import { Issue, type ReportIssueProps } from '../domain/issue.js';
import { districtDepartmentRouting } from '../domain/routing-decision.js';
import type { IssueRepository } from './ports.js';
import { RejectIssue } from './reject-issue.js';

// FR-IT-3: Reject the issue — London School, mock-driven (ADR-004 §2).
describe('RejectIssue (FR-IT-3)', () => {
  const villageId = asId<'VillageId'>('4a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d') as VillageId;
  const issueId = asId<'IssueId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as IssueId;
  const reportedAt = new Date('2026-07-28T09:00:00Z');
  const rejectedAt = new Date('2026-07-28T12:00:00Z');

  const props: ReportIssueProps = {
    villageId,
    category: 'water',
    description: 'No clean water for 5 days',
    reporterContact: '+911234567890',
  };

  function inProgressIssue(): Issue {
    const reported = unwrap(Issue.create(props, issueId, reportedAt));
    const routed = unwrap(reported.route(districtDepartmentRouting('public_health_engineering')));
    return unwrap(routed.progress());
  }

  function buildCollaborators(issue: Issue | null) {
    const issueRepository: IssueRepository = { save: vi.fn(), findById: vi.fn().mockResolvedValue(issue) };
    const eventPublisher: EventPublisher = { publish: vi.fn() };
    const clock: Clock = { now: vi.fn().mockReturnValue(rejectedAt) };
    return { issueRepository, eventPublisher, clock };
  }

  it('FR-IT-3 rejects an in_progress issue with a reason, saves it, and publishes IssueRejected', async () => {
    const issue = inProgressIssue();
    const { issueRepository, eventPublisher, clock } = buildCollaborators(issue);
    const useCase = new RejectIssue(issueRepository, eventPublisher, clock);

    const result = await useCase.execute(issueId, 'duplicate report');

    expect(result.ok).toBe(true);
    const rejected = unwrap(result);
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('duplicate report');
    expect(issueRepository.save).toHaveBeenCalledWith(rejected);
    expect(eventPublisher.publish).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'IssueRejected',
        occurredAt: rejectedAt,
        payload: { issueId, reason: 'duplicate report' },
      }),
    ]);
  });

  it('FR-IT-3 requires a rejection reason, and does not save or publish when missing', async () => {
    const issue = inProgressIssue();
    const { issueRepository, eventPublisher, clock } = buildCollaborators(issue);
    const useCase = new RejectIssue(issueRepository, eventPublisher, clock);

    const result = await useCase.execute(issueId, '   ');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ISSUE_REJECTION_REASON_REQUIRED');
    expect(issueRepository.save).not.toHaveBeenCalled();
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it('FR-IT-3 fails with INVALID_STATUS_TRANSITION when rejecting a merely reported issue (no skipping)', async () => {
    const reported = unwrap(Issue.create(props, issueId, reportedAt));
    const { issueRepository, eventPublisher, clock } = buildCollaborators(reported);
    const useCase = new RejectIssue(issueRepository, eventPublisher, clock);

    const result = await useCase.execute(issueId, 'some reason');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(issueRepository.save).not.toHaveBeenCalled();
  });

  it('FR-IT-3 fails with ISSUE_NOT_FOUND when the issue does not exist', async () => {
    const { issueRepository, eventPublisher, clock } = buildCollaborators(null);
    const useCase = new RejectIssue(issueRepository, eventPublisher, clock);

    const result = await useCase.execute(issueId, 'some reason');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ISSUE_NOT_FOUND');
  });
});
