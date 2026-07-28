import { asId, type Clock, type EventPublisher, type IdGenerator, type Result } from '../../../shared/index.js';
import { Issue, type ReportIssueProps } from '../domain/issue.js';
import { issueReportedEvent } from '../domain/issue-events.js';
import type { IssueRepository } from './ports.js';

/**
 * FR-IT-1: Report an issue with village, category, description, photos + GPS.
 * BC-6 Issue Tracking application use case.
 */
export class ReportIssue {
  constructor(
    private readonly issueRepository: IssueRepository,
    private readonly eventPublisher: EventPublisher,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(input: ReportIssueProps): Promise<Result<Issue>> {
    const reportedAt = this.clock.now();
    const id = asId<'IssueId'>(this.idGenerator.next());
    const created = Issue.create(input, id, reportedAt);
    if (!created.ok) return created;

    await this.issueRepository.save(created.value);
    await this.eventPublisher.publish([
      issueReportedEvent(
        { issueId: created.value.id, villageId: created.value.villageId, category: created.value.category },
        reportedAt,
      ),
    ]);

    return created;
  }
}
