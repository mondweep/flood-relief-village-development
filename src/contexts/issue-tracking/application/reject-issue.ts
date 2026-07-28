import { err, type Clock, type EventPublisher, type IssueId, type Result } from '../../../shared/index.js';
import { issueRejectedEvent } from '../domain/issue-events.js';
import type { Issue } from '../domain/issue.js';
import type { IssueRepository } from './ports.js';

/**
 * FR-IT-3: Reject the issue — in_progress → rejected; a reason is required,
 * publishing IssueRejected.
 * BC-6 Issue Tracking application use case.
 */
export class RejectIssue {
  constructor(
    private readonly issueRepository: IssueRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async execute(issueId: IssueId, reason: string): Promise<Result<Issue>> {
    const issue = await this.issueRepository.findById(issueId);
    if (!issue) return err('ISSUE_NOT_FOUND', `no issue with id ${issueId}`);

    const rejected = issue.reject(reason);
    if (!rejected.ok) return rejected;

    const occurredAt = this.clock.now();
    await this.issueRepository.save(rejected.value);
    await this.eventPublisher.publish([issueRejectedEvent({ issueId: rejected.value.id, reason }, occurredAt)]);

    return rejected;
  }
}
