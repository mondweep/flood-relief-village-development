import {
  err,
  issueId,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { IssueCategory, PartyType } from "../domain/issue.js";
import { determineRouting } from "../domain/routing-policy.js";
import type { AssignmentLookup, IssueRepository } from "./ports.js";

export interface RouteIssueInput {
  issueId: string;
}

export interface RouteIssueOutput {
  issueId: string;
  partyType: PartyType;
  party: string;
}

export interface RouteIssueDeps {
  repository: IssueRepository;
  assignmentLookup: AssignmentLookup;
  clock: Clock;
  eventPublisher: EventPublisher;
}

const NGO_ROUTABLE_CATEGORIES: readonly IssueCategory[] = [
  "infrastructure",
  "water",
  "food",
  "education",
];

export class RouteIssue {
  constructor(private readonly deps: RouteIssueDeps) {}

  async execute(input: RouteIssueInput): Promise<Result<RouteIssueOutput>> {
    const idResult = issueId(input.issueId);
    if (!idResult.ok) return err(idResult.error);

    const issue = await this.deps.repository.findById(idResult.value);
    if (!issue) return err(`Issue not found: ${input.issueId}`);

    const leadNgo = (NGO_ROUTABLE_CATEGORIES as readonly string[]).includes(issue.category)
      ? await this.deps.assignmentLookup.findLeadNgo(issue.villageId)
      : null;

    const decision = determineRouting(issue.category, leadNgo);

    const routeResult = issue.route(decision, this.deps.clock.now().toISOString());
    if (!routeResult.ok) return err(routeResult.error);

    await this.deps.repository.save(issue);

    const event: DomainEvent = {
      name: "issue.routed.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload: { issueId: issue.id, partyType: decision.partyType, party: decision.party },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ issueId: issue.id, partyType: decision.partyType, party: decision.party });
  }
}
