/** FR-FM-1: create a funded project with a sanctioned budget and funding source. */
import { type Clock, type EventPublisher, type Result, err, ok } from '../../../shared/index.js';
import {
  type FundedProject,
  createFundedProject,
  isFundingSource,
  isProjectCategory,
  projectFunded,
} from '../domain/index.js';
import { parseAmount, parseProjectId, parseVillageId } from './boundary.js';
import type { ProjectRepository } from './ports.js';

export interface CreateFundedProjectDeps {
  readonly projects: ProjectRepository;
  readonly events: EventPublisher;
  readonly clock: Clock;
}

export interface CreateFundedProjectCommand {
  readonly projectId: string;
  readonly villageId: string;
  readonly title: string;
  readonly category: string;
  readonly fundingSource: string;
  readonly sanctionedAmountMinor: number;
  readonly currency?: string;
  readonly expectedCompletionAt: Date;
}

export interface CreateFundedProject {
  execute(command: CreateFundedProjectCommand): Promise<Result<FundedProject>>;
}

export const makeCreateFundedProject = (deps: CreateFundedProjectDeps): CreateFundedProject => ({
  async execute(command) {
    const id = parseProjectId(command.projectId);
    if (!id.ok) return id;

    const villageId = parseVillageId(command.villageId);
    if (!villageId.ok) return villageId;

    if (!isProjectCategory(command.category)) {
      return err('UNKNOWN_CATEGORY', `unknown project category: ${command.category}`);
    }
    if (!isFundingSource(command.fundingSource)) {
      return err('UNKNOWN_FUNDING_SOURCE', `unknown funding source: ${command.fundingSource}`);
    }

    const sanctioned = parseAmount(command.sanctionedAmountMinor, command.currency);
    if (!sanctioned.ok) return sanctioned;

    const existing = await deps.projects.findById(id.value);
    if (existing !== null) {
      return err('PROJECT_ALREADY_EXISTS', `project ${command.projectId} already exists`);
    }

    const sanctionedAt = deps.clock.now();
    const project = createFundedProject({
      id: id.value,
      villageId: villageId.value,
      title: command.title,
      category: command.category,
      fundingSource: command.fundingSource,
      sanctioned: sanctioned.value,
      sanctionedAt,
      expectedCompletionAt: command.expectedCompletionAt,
    });
    if (!project.ok) return project;

    await deps.projects.save(project.value);
    await deps.events.publish([projectFunded(project.value, sanctionedAt)]);

    return ok(project.value);
  },
});
