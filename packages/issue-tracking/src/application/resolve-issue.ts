import {
  err,
  issueId,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { IssueRepository } from "./ports.js";

export interface ResolveIssueInput {
  issueId: string;
  resolutionNote: string;
}

export interface ResolveIssueOutput {
  issueId: string;
}

export interface ResolveIssueDeps {
  repository: IssueRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class ResolveIssue {
  constructor(private readonly deps: ResolveIssueDeps) {}

  async execute(input: ResolveIssueInput): Promise<Result<ResolveIssueOutput>> {
    const idResult = issueId(input.issueId);
    if (!idResult.ok) return err(idResult.error);

    const issue = await this.deps.repository.findById(idResult.value);
    if (!issue) return err(`Issue not found: ${input.issueId}`);

    const resolveResult = issue.resolve(input.resolutionNote, this.deps.clock.now().toISOString());
    if (!resolveResult.ok) return err(resolveResult.error);

    await this.deps.repository.save(issue);

    const event: DomainEvent = {
      name: "issue.resolved.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload: { issueId: issue.id, resolutionNote: issue.resolutionNote },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ issueId: issue.id });
  }
}
