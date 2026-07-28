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

export interface CompleteProjectInput {
  projectId: string;
}

export interface CompleteProjectOutput {
  projectId: string;
  status: ProjectStatus;
}

export interface CompleteProjectDeps {
  repository: ProjectRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class CompleteProject {
  constructor(private readonly deps: CompleteProjectDeps) {}

  async execute(input: CompleteProjectInput): Promise<Result<CompleteProjectOutput>> {
    const pid = projectId(input.projectId);
    if (!pid.ok) return err(pid.error);

    const project = await this.deps.repository.findById(pid.value);
    if (!project) return err(`Project not found: ${input.projectId}`);

    const completed = project.complete();
    if (!completed.ok) return err(completed.error);

    await this.deps.repository.save(project);
    await this.deps.eventPublisher.publish([
      {
        name: "project.completed.v1",
        occurredAt: this.deps.clock.now().toISOString(),
        payload: { projectId: project.id as string },
      },
    ]);

    return ok({ projectId: project.id, status: project.status });
  }
}
