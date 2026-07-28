import type { BeneficiaryId } from '../../../shared/index.js';
import type { Beneficiary } from '../domain/beneficiary.js';

/**
 * Port: persistence for the Beneficiary aggregate.
 * Implemented by the infrastructure layer (Supabase adapter, in-memory fake for tests, etc).
 */
export interface BeneficiaryRepository {
  findById(id: BeneficiaryId): Promise<Beneficiary | undefined>;
  save(beneficiary: Beneficiary): Promise<void>;
  /** FR-BR-4: all beneficiaries that currently carry a scheduled next follow-up date. */
  findAllWithScheduledFollowUp(): Promise<readonly Beneficiary[]>;
}
