import {
  err,
  ok,
  projectId,
  type Clock,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { ProjectStatus } from "../domain/funded-project.js";
import type { ProjectRepository } from "./ports.js";

export interface VerifyProjectInput {
  projectId: string;
}

export interface VerifyProjectOutput {
  projectId: string;
  status: ProjectStatus;
}

export interface VerifyProjectDeps {
  repository: ProjectRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

/** Village verification of a completed project. */
export class VerifyProject {
  constructor(private readonly deps: VerifyProjectDeps) {}

  async execute(input: VerifyProjectInput): Promise<Result<VerifyProjectOutput>> {
    const pid = projectId(input.projectId);
    if (!pid.ok) return err(pid.error);

    const project = await this.deps.repository.findById(pid.value);
    if (!project) return err(`Project not found: ${input.projectId}`);

    const verified = project.verify();
    if (!verified.ok) return err(verified.error);

    await this.deps.repository.save(project);
    await this.deps.eventPublisher.publish([
      {
        name: "project.verified.v1",
        occurredAt: this.deps.clock.now().toISOString(),
        payload: { projectId: project.id as string },
      },
    ]);

    return ok({ projectId: project.id, status: project.status });
  }
}
