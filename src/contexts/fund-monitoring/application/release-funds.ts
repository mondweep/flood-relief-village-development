/** FR-FM-2: release funds, never beyond the sanctioned budget. */
import { type Clock, type EventPublisher, type Result, err, ok } from '../../../shared/index.js';
import { type FundedProject, fundsReleased, releaseFunds } from '../domain/index.js';
import { parseAmount, parseProjectId } from './boundary.js';
import type { ProjectRepository } from './ports.js';

export interface ReleaseFundsDeps {
  readonly projects: ProjectRepository;
  readonly events: EventPublisher;
  readonly clock: Clock;
}

export interface ReleaseFundsCommand {
  readonly projectId: string;
  readonly amountMinor: number;
  readonly currency?: string;
}

export interface ReleaseFunds {
  execute(command: ReleaseFundsCommand): Promise<Result<FundedProject>>;
}

export const makeReleaseFunds = (deps: ReleaseFundsDeps): ReleaseFunds => ({
  async execute(command) {
    const id = parseProjectId(command.projectId);
    if (!id.ok) return id;

    const amount = parseAmount(command.amountMinor, command.currency);
    if (!amount.ok) return amount;

    const project = await deps.projects.findById(id.value);
    if (project === null) return err('PROJECT_NOT_FOUND', `no funded project ${command.projectId}`);

    const at = deps.clock.now();
    const released = releaseFunds(project, amount.value, at);
    if (!released.ok) return released;

    await deps.projects.save(released.value);
    await deps.events.publish([fundsReleased(released.value, amount.value, at)]);

    return ok(released.value);
  },
});
