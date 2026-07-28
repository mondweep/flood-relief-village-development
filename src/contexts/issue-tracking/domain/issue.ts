import { type Result, ok, err, type IssueId, type VillageId } from '../../../shared/index.js';
import type { Attachment } from './attachment.js';
import type { IssueCategory } from './issue-category.js';
import { type IssueStatus, transition } from './issue-status.js';
import type { RoutingDecision } from './routing-decision.js';

/**
 * BC-6 Issue Tracking — Issue aggregate (PRD §5 BC-6).
 * Pure, I/O-free (ADR-004): construction and transitions return new
 * immutable Issue instances wrapped in Result.
 */
export interface ReportIssueProps {
  readonly villageId: VillageId;
  readonly category: IssueCategory;
  readonly description: string;
  readonly reporterContact: string;
  readonly attachments?: readonly Attachment[];
}

interface IssueProps {
  readonly id: IssueId;
  readonly villageId: VillageId;
  readonly category: IssueCategory;
  readonly description: string;
  readonly reporterContact: string;
  readonly attachments: readonly Attachment[];
  readonly status: IssueStatus;
  readonly reportedAt: Date;
  readonly routingDecision: RoutingDecision | null;
  readonly rejectionReason: string | null;
}

export class Issue {
  private constructor(private readonly props: IssueProps) {}

  /** FR-IT-1: an issue requires villageId, category, non-empty description, reporter contact. */
  static create(props: ReportIssueProps, id: IssueId, reportedAt: Date): Result<Issue> {
    if (props.description.trim().length === 0) {
      return err('ISSUE_EMPTY_DESCRIPTION', 'issue description must not be empty');
    }
    if (props.reporterContact.trim().length === 0) {
      return err('ISSUE_EMPTY_REPORTER_CONTACT', 'reporter contact must not be empty');
    }
    return ok(
      new Issue({
        id,
        villageId: props.villageId,
        category: props.category,
        description: props.description,
        reporterContact: props.reporterContact,
        attachments: props.attachments ?? [],
        status: 'reported',
        reportedAt,
        routingDecision: null,
        rejectionReason: null,
      }),
    );
  }

  get id(): IssueId {
    return this.props.id;
  }

  get villageId(): VillageId {
    return this.props.villageId;
  }

  get category(): IssueCategory {
    return this.props.category;
  }

  get description(): string {
    return this.props.description;
  }

  get reporterContact(): string {
    return this.props.reporterContact;
  }

  get attachments(): readonly Attachment[] {
    return this.props.attachments;
  }

  get status(): IssueStatus {
    return this.props.status;
  }

  get reportedAt(): Date {
    return this.props.reportedAt;
  }

  get routingDecision(): RoutingDecision | null {
    return this.props.routingDecision;
  }

  get rejectionReason(): string | null {
    return this.props.rejectionReason;
  }

  /** FR-IT-2 / FR-IT-3: reported → routed, carrying the routing decision. */
  route(decision: RoutingDecision): Result<Issue> {
    const next = transition(this.props.status, 'routed');
    if (!next.ok) return next;
    return ok(new Issue({ ...this.props, status: next.value, routingDecision: decision }));
  }

  /** FR-IT-3: routed → in_progress. */
  progress(): Result<Issue> {
    const next = transition(this.props.status, 'in_progress');
    if (!next.ok) return next;
    return ok(new Issue({ ...this.props, status: next.value }));
  }

  /** FR-IT-3: in_progress → resolved. */
  resolve(): Result<Issue> {
    const next = transition(this.props.status, 'resolved');
    if (!next.ok) return next;
    return ok(new Issue({ ...this.props, status: next.value }));
  }

  /** FR-IT-3: in_progress → rejected; a reason is required. */
  reject(reason: string): Result<Issue> {
    if (reason.trim().length === 0) {
      return err('ISSUE_REJECTION_REASON_REQUIRED', 'a rejection reason is required');
    }
    const next = transition(this.props.status, 'rejected');
    if (!next.ok) return next;
    return ok(new Issue({ ...this.props, status: next.value, rejectionReason: reason }));
  }
}
