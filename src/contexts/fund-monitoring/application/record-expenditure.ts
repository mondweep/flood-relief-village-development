/** FR-FM-2: record an expenditure, never beyond the funds actually released. */
import { type Clock, type EventPublisher, type Result, err, ok } from '../../../shared/index.js';
import { type FundedProject, expenditureRecorded, recordExpenditure } from '../domain/index.js';
import { parseAmount, parseProjectId } from './boundary.js';
import type { ProjectRepository } from './ports.js';

export interface RecordExpenditureDeps {
  readonly projects: ProjectRepository;
  readonly events: EventPublisher;
  readonly clock: Clock;
}

export interface RecordExpenditureCommand {
  readonly projectId: string;
  readonly amountMinor: number;
  readonly currency?: string;
  readonly description: string;
}

export interface RecordExpenditure {
  execute(command: RecordExpenditureCommand): Promise<Result<FundedProject>>;
}

export const makeRecordExpenditure = (deps: RecordExpenditureDeps): RecordExpenditure => ({
  async execute(command) {
    const id = parseProjectId(command.projectId);
    if (!id.ok) return id;

    const amount = parseAmount(command.amountMinor, command.currency);
    if (!amount.ok) return amount;

    const project = await deps.projects.findById(id.value);
    if (project === null) return err('PROJECT_NOT_FOUND', `no funded project ${command.projectId}`);

    const at = deps.clock.now();
    const spent = recordExpenditure(project, amount.value, command.description, at);
    if (!spent.ok) return spent;

    await deps.projects.save(spent.value);
    await deps.events.publish([
      expenditureRecorded(spent.value, amount.value, command.description.trim(), at),
    ]);

    return ok(spent.value);
  },
});
