import {
  err,
  Money,
  ok,
  projectId,
  type Clock,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { ProjectStatus } from "../domain/funded-project.js";
import type { ProjectRepository } from "./ports.js";

export interface ReleaseFundsInput {
  projectId: string;
  amountMinor: number;
}

export interface ReleaseFundsOutput {
  projectId: string;
  totalReleasedMinor: number;
  status: ProjectStatus;
}

export interface ReleaseFundsDeps {
  repository: ProjectRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class ReleaseFunds {
  constructor(private readonly deps: ReleaseFundsDeps) {}

  async execute(input: ReleaseFundsInput): Promise<Result<ReleaseFundsOutput>> {
    const pid = projectId(input.projectId);
    if (!pid.ok) return err(pid.error);

    const amount = Money.of(input.amountMinor);
    if (!amount.ok) return err(amount.error);
    if (amount.value.amountMinor <= 0) return err("release amount must be positive");

    const project = await this.deps.repository.findById(pid.value);
    if (!project) return err(`Project not found: ${input.projectId}`);

    const now = this.deps.clock.now();
    const released = project.release(amount.value, now);
    if (!released.ok) return err(released.error);

    await this.deps.repository.save(project);
    await this.deps.eventPublisher.publish([
      {
        name: "project.funds-released.v1",
        occurredAt: now.toISOString(),
        payload: {
          projectId: project.id as string,
          amountMinor: amount.value.amountMinor,
          totalReleasedMinor: project.released.amountMinor,
          status: project.status,
        },
      },
    ]);

    return ok({
      projectId: project.id,
      totalReleasedMinor: project.released.amountMinor,
      status: project.status,
    });
  }
}
