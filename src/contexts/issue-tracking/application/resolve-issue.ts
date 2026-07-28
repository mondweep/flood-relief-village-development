import { err, type Clock, type EventPublisher, type IssueId, type Result } from '../../../shared/index.js';
import { issueResolvedEvent } from '../domain/issue-events.js';
import type { Issue } from '../domain/issue.js';
import type { IssueRepository } from './ports.js';

/**
 * FR-IT-3: Resolve the issue — in_progress → resolved, publishing IssueResolved.
 * BC-6 Issue Tracking application use case.
 */
export class ResolveIssue {
  constructor(
    private readonly issueRepository: IssueRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async execute(issueId: IssueId): Promise<Result<Issue>> {
    const issue = await this.issueRepository.findById(issueId);
    if (!issue) return err('ISSUE_NOT_FOUND', `no issue with id ${issueId}`);

    const resolved = issue.resolve();
    if (!resolved.ok) return resolved;

    const occurredAt = this.clock.now();
    await this.issueRepository.save(resolved.value);
    await this.eventPublisher.publish([issueResolvedEvent({ issueId: resolved.value.id }, occurredAt)]);

    return resolved;
  }
}
