import { describe, expect, it, vi } from 'vitest';
import { asId, unwrap, type IssueId, type VillageId } from '../../../shared/index.js';
import { Issue, type ReportIssueProps } from '../domain/issue.js';
import { districtDepartmentRouting } from '../domain/routing-decision.js';
import type { IssueRepository } from './ports.js';
import { ProgressIssue } from './progress-issue.js';

// FR-IT-3: Progress the status machine — London School, mock-driven (ADR-004 §2).
describe('ProgressIssue (FR-IT-3)', () => {
  const villageId = asId<'VillageId'>('4a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d') as VillageId;
  const issueId = asId<'IssueId'>('3f8e9a1c-2b4d-4e6f-8a0b-1c2d3e4f5a6b') as IssueId;
  const reportedAt = new Date('2026-07-28T09:00:00Z');

  const props: ReportIssueProps = {
    villageId,
    category: 'water',
    description: 'No clean water for 5 days',
    reporterContact: '+911234567890',
  };

  function buildRepository(issue: Issue | null): IssueRepository {
    return { save: vi.fn(), findById: vi.fn().mockResolvedValue(issue) };
  }

  it('FR-IT-3 progresses a routed issue to in_progress and saves it', async () => {
    const reported = unwrap(Issue.create(props, issueId, reportedAt));
    const routed = unwrap(reported.route(districtDepartmentRouting('public_health_engineering')));
    const issueRepository = buildRepository(routed);
    const useCase = new ProgressIssue(issueRepository);

    const result = await useCase.execute(issueId);

    expect(result.ok).toBe(true);
    const progressed = unwrap(result);
    expect(progressed.status).toBe('in_progress');
    expect(issueRepository.save).toHaveBeenCalledWith(progressed);
  });

  it('FR-IT-3 fails with INVALID_STATUS_TRANSITION when progressing a reported (not yet routed) issue', async () => {
    const reported = unwrap(Issue.create(props, issueId, reportedAt));
    const issueRepository = buildRepository(reported);
    const useCase = new ProgressIssue(issueRepository);

    const result = await useCase.execute(issueId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(issueRepository.save).not.toHaveBeenCalled();
  });

  it('FR-IT-3 fails with ISSUE_NOT_FOUND when the issue does not exist', async () => {
    const issueRepository = buildRepository(null);
    const useCase = new ProgressIssue(issueRepository);

    const result = await useCase.execute(issueId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ISSUE_NOT_FOUND');
  });
});
