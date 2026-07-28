import {
  err,
  Money,
  ok,
  projectId,
  type Clock,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { ProjectRepository } from "./ports.js";

export interface RecordExpenditureInput {
  projectId: string;
  amountMinor: number;
  description: string;
  evidenceRef?: string;
}

export interface RecordExpenditureOutput {
  projectId: string;
  totalSpentMinor: number;
}

export interface RecordExpenditureDeps {
  repository: ProjectRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class RecordExpenditure {
  constructor(private readonly deps: RecordExpenditureDeps) {}

  async execute(input: RecordExpenditureInput): Promise<Result<RecordExpenditureOutput>> {
    const pid = projectId(input.projectId);
    if (!pid.ok) return err(pid.error);

    const amount = Money.of(input.amountMinor);
    if (!amount.ok) return err(amount.error);

    const project = await this.deps.repository.findById(pid.value);
    if (!project) return err(`Project not found: ${input.projectId}`);

    const now = this.deps.clock.now();
    const recorded = project.recordExpenditure(
      amount.value,
      input.description,
      now,
      input.evidenceRef,
    );
    if (!recorded.ok) return err(recorded.error);

    await this.deps.repository.save(project);
    await this.deps.eventPublisher.publish([
      {
        name: "project.expenditure-recorded.v1",
        occurredAt: now.toISOString(),
        payload: {
          projectId: project.id as string,
          amountMinor: amount.value.amountMinor,
          description: input.description,
          totalSpentMinor: project.spent.amountMinor,
          evidenceRef: input.evidenceRef ?? null,
        },
      },
    ]);

    return ok({ projectId: project.id, totalSpentMinor: project.spent.amountMinor });
  }
}
