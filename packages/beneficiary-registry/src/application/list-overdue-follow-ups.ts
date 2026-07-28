import { ok, type Clock, type Result } from "@afrip/shared-kernel";
import type { BeneficiaryRepository } from "./ports.js";

export interface OverdueFollowUp {
  beneficiaryId: string;
  name: string;
  villageId: string;
  followUpId: string;
  dueAt: string;
}

export interface ListOverdueFollowUpsDeps {
  repository: BeneficiaryRepository;
  clock: Clock;
}

export class ListOverdueFollowUps {
  constructor(private readonly deps: ListOverdueFollowUpsDeps) {}

  async execute(): Promise<Result<OverdueFollowUp[]>> {
    const beneficiaries = await this.deps.repository.listAll();
    const now = this.deps.clock.now();

    const overdue: OverdueFollowUp[] = [];
    for (const beneficiary of beneficiaries) {
      for (const followUp of beneficiary.overdueFollowUps(now)) {
        overdue.push({
          beneficiaryId: beneficiary.id,
          name: beneficiary.name,
          villageId: beneficiary.villageId,
          followUpId: followUp.id,
          dueAt: followUp.dueAt,
        });
      }
    }
    return ok(overdue);
  }
}
