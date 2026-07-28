import {
  err,
  Money,
  ok,
  projectId,
  villageId,
  type Clock,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";
import { FundedProject, isFundSource, isProjectCategory } from "../domain/funded-project.js";
import type { ProjectRepository } from "./ports.js";

export interface SanctionProjectInput {
  villageId: string;
  name: string;
  category: string;
  fundSource: string;
  sanctionedMinor: number;
}

export interface SanctionProjectOutput {
  projectId: string;
}

export interface SanctionProjectDeps {
  repository: ProjectRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class SanctionProject {
  constructor(private readonly deps: SanctionProjectDeps) {}

  async execute(input: SanctionProjectInput): Promise<Result<SanctionProjectOutput>> {
    const vid = villageId(input.villageId);
    if (!vid.ok) return err(vid.error);
    if (!isProjectCategory(input.category)) return err(`invalid category: ${input.category}`);
    if (!isFundSource(input.fundSource)) return err(`invalid fundSource: ${input.fundSource}`);

    const sanctioned = Money.of(input.sanctionedMinor);
    if (!sanctioned.ok) return err(sanctioned.error);

    const pid = projectId(this.deps.idGenerator.next());
    if (!pid.ok) return err(pid.error);

    const project = FundedProject.sanction({
      id: pid.value,
      villageId: vid.value,
      name: input.name,
      category: input.category,
      fundSource: input.fundSource,
      sanctioned: sanctioned.value,
    });
    if (!project.ok) return err(project.error);

    await this.deps.repository.save(project.value);
    await this.deps.eventPublisher.publish([
      {
        name: "project.sanctioned.v1",
        occurredAt: this.deps.clock.now().toISOString(),
        payload: {
          projectId: pid.value as string,
          villageId: vid.value as string,
          sanctionedMinor: sanctioned.value.amountMinor,
        },
      },
    ]);

    return ok({ projectId: pid.value });
  }
}
