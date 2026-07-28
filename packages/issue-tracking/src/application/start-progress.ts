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

export interface StartProgressInput {
  issueId: string;
}

export interface StartProgressOutput {
  issueId: string;
}

export interface StartProgressDeps {
  repository: IssueRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class StartProgress {
  constructor(private readonly deps: StartProgressDeps) {}

  async execute(input: StartProgressInput): Promise<Result<StartProgressOutput>> {
    const idResult = issueId(input.issueId);
    if (!idResult.ok) return err(idResult.error);

    const issue = await this.deps.repository.findById(idResult.value);
    if (!issue) return err(`Issue not found: ${input.issueId}`);

    const startResult = issue.startProgress(this.deps.clock.now().toISOString());
    if (!startResult.ok) return err(startResult.error);

    await this.deps.repository.save(issue);

    const event: DomainEvent = {
      name: "issue.progress-started.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload: { issueId: issue.id },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ issueId: issue.id });
  }
}
