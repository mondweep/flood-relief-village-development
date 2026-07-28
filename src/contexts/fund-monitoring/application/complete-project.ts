/** FR-FM-3: complete a project — only with village verification evidence. */
import { type Clock, type EventPublisher, type Result, err, ok } from '../../../shared/index.js';
import { type FundedProject, completeProject, projectCompleted } from '../domain/index.js';
import { parseProjectId } from './boundary.js';
import type { ProjectRepository } from './ports.js';

export interface CompleteProjectDeps {
  readonly projects: ProjectRepository;
  readonly events: EventPublisher;
  readonly clock: Clock;
}

export interface CompleteProjectCommand {
  readonly projectId: string;
}

export interface CompleteProject {
  execute(command: CompleteProjectCommand): Promise<Result<FundedProject>>;
}

export const makeCompleteProject = (deps: CompleteProjectDeps): CompleteProject => ({
  async execute(command) {
    const id = parseProjectId(command.projectId);
    if (!id.ok) return id;

    const project = await deps.projects.findById(id.value);
    if (project === null) return err('PROJECT_NOT_FOUND', `no funded project ${command.projectId}`);

    const at = deps.clock.now();
    const completed = completeProject(project, at);
    if (!completed.ok) return completed;

    await deps.projects.save(completed.value);
    await deps.events.publish([projectCompleted(completed.value, at)]);

    return ok(completed.value);
  },
});
