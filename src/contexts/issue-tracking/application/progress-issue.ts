import { err, type IssueId, type Result } from '../../../shared/index.js';
import type { Issue } from '../domain/issue.js';
import type { IssueRepository } from './ports.js';

/**
 * FR-IT-3: Progress the status machine — routed → in_progress.
 * No domain event is defined for this transition (PRD §5 BC-6 events list).
 * BC-6 Issue Tracking application use case.
 */
export class ProgressIssue {
  constructor(private readonly issueRepository: IssueRepository) {}

  async execute(issueId: IssueId): Promise<Result<Issue>> {
    const issue = await this.issueRepository.findById(issueId);
    if (!issue) return err('ISSUE_NOT_FOUND', `no issue with id ${issueId}`);

    const progressed = issue.progress();
    if (!progressed.ok) return progressed;

    await this.issueRepository.save(progressed.value);
    return progressed;
  }
}
