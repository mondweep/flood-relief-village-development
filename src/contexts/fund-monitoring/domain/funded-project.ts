/**
 * FundedProject aggregate root (PRD §5 BC-4).
 * Pure and I/O free: every operation returns a new aggregate or a domain error.
 */
import {
  type Money,
  type ProjectId,
  type Result,
  type VillageId,
  err,
  ok,
} from '../../../shared/index.js';
import {
  type BudgetLedger,
  createBudgetLedger,
  recordRelease,
  recordSpend,
} from './budget-ledger.js';
import type { EvidenceItem } from './evidence.js';
import type { FundingSource, ProjectCategory, ProjectStatus } from './types.js';

export interface FundedProject {
  readonly id: ProjectId;
  readonly villageId: VillageId;
  readonly title: string;
  readonly category: ProjectCategory;
  readonly fundingSource: FundingSource;
  readonly ledger: BudgetLedger;
  readonly evidence: readonly EvidenceItem[];
  readonly sanctionedAt: Date;
  readonly expectedCompletionAt: Date;
  readonly status: ProjectStatus;
  readonly completedAt?: Date;
}

export interface NewFundedProject {
  readonly id: ProjectId;
  readonly villageId: VillageId;
  readonly title: string;
  readonly category: ProjectCategory;
  readonly fundingSource: FundingSource;
  readonly sanctioned: Money;
  readonly sanctionedAt: Date;
  readonly expectedCompletionAt: Date;
}

/** FR-FM-1: create a funded project with a sanctioned budget and a funding source. */
export function createFundedProject(input: NewFundedProject): Result<FundedProject> {
  const title = input.title.trim();
  if (title === '') return err('PROJECT_NEEDS_TITLE', 'a funded project needs a title');

  if (input.expectedCompletionAt.getTime() <= input.sanctionedAt.getTime()) {
    return err(
      'PROJECT_BAD_COMPLETION_DATE',
      'expected completion date must be after the sanction date',
    );
  }

  const ledger = createBudgetLedger(input.sanctioned);
  if (!ledger.ok) return ledger;

  return ok({
    id: input.id,
    villageId: input.villageId,
    title,
    category: input.category,
    fundingSource: input.fundingSource,
    ledger: ledger.value,
    evidence: [],
    sanctionedAt: input.sanctionedAt,
    expectedCompletionAt: input.expectedCompletionAt,
    status: 'sanctioned',
  });
}

const guardOpen = (project: FundedProject): Result<true> =>
  project.status === 'completed'
    ? err('PROJECT_ALREADY_COMPLETED', `project ${project.id} is already completed`)
    : ok(true);

/** FR-FM-2: release funds against the sanctioned budget. */
export function releaseFunds(
  project: FundedProject,
  amount: Money,
  at: Date,
): Result<FundedProject> {
  const open = guardOpen(project);
  if (!open.ok) return open;

  const ledger = recordRelease(project.ledger, amount, at);
  if (!ledger.ok) return ledger;

  return ok({ ...project, ledger: ledger.value, status: 'in_progress' });
}

/** FR-FM-2: record an expenditure against released funds. */
export function recordExpenditure(
  project: FundedProject,
  amount: Money,
  description: string,
  at: Date,
): Result<FundedProject> {
  const open = guardOpen(project);
  if (!open.ok) return open;

  const ledger = recordSpend(project.ledger, amount, description, at);
  if (!ledger.ok) return ledger;

  return ok({ ...project, ledger: ledger.value });
}

/** FR-FM-3: evidence is append-only (NFR-1 auditability). */
export function attachEvidence(project: FundedProject, item: EvidenceItem): Result<FundedProject> {
  return ok({ ...project, evidence: [...project.evidence, item] });
}

export const hasVillageVerification = (project: FundedProject): boolean =>
  project.evidence.some((e) => e.kind === 'village_verification');

/** FR-FM-3: a project may only be completed once the village has verified it. */
export function completeProject(project: FundedProject, at: Date): Result<FundedProject> {
  const open = guardOpen(project);
  if (!open.ok) return open;

  if (!hasVillageVerification(project)) {
    return err(
      'COMPLETION_NEEDS_VILLAGE_VERIFICATION',
      'completion requires at least one village_verification evidence item',
    );
  }

  return ok({ ...project, status: 'completed', completedAt: at });
}
