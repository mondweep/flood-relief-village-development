import type { Clock, Result } from '../../../shared/index.js';
import { ok } from '../../../shared/index.js';
import type { Beneficiary } from '../domain/beneficiary.js';
import type { BeneficiaryRepository } from './ports.js';

export interface FindOverdueFollowUpsOutput {
  readonly overdue: readonly Beneficiary[];
}

/**
 * FR-BR-4: returns beneficiaries whose nextFollowUpAt is before now.
 * Deliberately side-effect free — flagging FollowUpOverdue is the caller's responsibility.
 */
export class FindOverdueFollowUps {
  constructor(
    private readonly repository: BeneficiaryRepository,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<Result<FindOverdueFollowUpsOutput>> {
    const now = this.clock.now();
    const scheduled = await this.repository.findAllWithScheduledFollowUp();
    const overdue = scheduled.filter((beneficiary) => beneficiary.isFollowUpOverdue(now));
    return ok({ overdue });
  }
}
