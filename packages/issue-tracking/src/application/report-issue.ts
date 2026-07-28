import {
  err,
  issueId,
  ok,
  villageId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";
import { Issue, type GpsCoordinates, type IssueCategory } from "../domain/issue.js";
import type { IssueRepository } from "./ports.js";

export interface ReportIssueInput {
  villageId: string;
  category: IssueCategory;
  description: string;
  photoRefs: string[];
  gps: GpsCoordinates;
}

export interface ReportIssueOutput {
  issueId: string;
}

export interface ReportIssueDeps {
  repository: IssueRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class ReportIssue {
  constructor(private readonly deps: ReportIssueDeps) {}

  async execute(input: ReportIssueInput): Promise<Result<ReportIssueOutput>> {
    const villageIdResult = villageId(input.villageId);
    if (!villageIdResult.ok) return err(villageIdResult.error);

    const idResult = issueId(this.deps.idGenerator.next());
    if (!idResult.ok) return err(idResult.error);

    const issueResult = Issue.create({
      id: idResult.value,
      villageId: villageIdResult.value,
      category: input.category,
      description: input.description,
      photoRefs: input.photoRefs,
      gps: input.gps,
      reportedAt: this.deps.clock.now().toISOString(),
    });
    if (!issueResult.ok) return err(issueResult.error);

    const issue = issueResult.value;
    await this.deps.repository.save(issue);

    const event: DomainEvent = {
      name: "issue.reported.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload: { issueId: issue.id, villageId: issue.villageId, category: issue.category },
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ issueId: issue.id });
  }
}
