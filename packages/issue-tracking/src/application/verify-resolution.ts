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

export interface VerifyResolutionInput {
  issueId: string;
}

export interface VerifyResolutionOutput {
  issueId: string;
}

export interface VerifyResolutionDeps {
  repository: IssueRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class VerifyResolution {
  constructor(private readonly deps: VerifyResolutionDeps) {}

  async execute(input: VerifyResolutionInput): Promise<Result<VerifyResolutionOutput>> {
    const idResult = issueId(input.issueId);
    if (!idResult.ok) return err(idResult.error);

    const issue = await this.deps.repository.findById(idResult.value);
    if (!issue) return err(`Issue not found: ${input.issueId}`);

    const verifyResult = issue.verify(this.deps.clock.now().toISOString());
    if (!verifyResult.ok) return err(verifyResult.error);

    await this.deps.repository.save(issue);

    const event: DomainEvent = {
      name: "issue.verified.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload: { issueId: issue.id },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ issueId: issue.id });
  }
}
