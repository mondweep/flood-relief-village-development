import { err, type Clock, type EventPublisher, type IssueId, type Result } from '../../../shared/index.js';
import { departmentForCategory, DISTRICT_ADMINISTRATION_DEPARTMENT } from '../domain/issue-category.js';
import { issueRoutedEvent } from '../domain/issue-events.js';
import type { Issue } from '../domain/issue.js';
import { districtDepartmentRouting, ngoRouting, type RoutingDecision } from '../domain/routing-decision.js';
import type { AssignmentLookup, IssueRepository } from './ports.js';

/**
 * FR-IT-2: Route an issue automatically per the routing policy.
 * - 'corruption' ALWAYS routes to district administration — the NGO
 *   assignment lookup is never consulted for corruption reports.
 * - Other categories route to the village's assigned NGO if one exists,
 *   else to the district department mapped from the category.
 * BC-6 Issue Tracking application use case.
 */
export class RouteIssue {
  constructor(
    private readonly issueRepository: IssueRepository,
    private readonly assignmentLookup: AssignmentLookup,
    private readonly eventPublisher: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async execute(issueId: IssueId): Promise<Result<Issue>> {
    const issue = await this.issueRepository.findById(issueId);
    if (!issue) return err('ISSUE_NOT_FOUND', `no issue with id ${issueId}`);

    const decision = await this.decideRouting(issue);

    const routed = issue.route(decision);
    if (!routed.ok) return routed;

    const occurredAt = this.clock.now();
    await this.issueRepository.save(routed.value);
    await this.eventPublisher.publish([issueRoutedEvent({ issueId: routed.value.id, routingDecision: decision }, occurredAt)]);

    return routed;
  }

  private async decideRouting(issue: Issue): Promise<RoutingDecision> {
    if (issue.category === 'corruption') {
      return districtDepartmentRouting(DISTRICT_ADMINISTRATION_DEPARTMENT);
    }

    const ngoId = await this.assignmentLookup.findActiveNgoForVillage(issue.villageId);
    if (ngoId) return ngoRouting(ngoId);

    return districtDepartmentRouting(departmentForCategory(issue.category));
  }
}
