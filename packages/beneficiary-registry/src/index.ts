export type {
  AidRecord,
  AidType,
  BeneficiaryCategory,
  BeneficiaryCreateProps,
  DuplicateFlag,
  FollowUp,
  ProviderType,
  RecordAidInput as RecordAidDomainInput,
  RecordAidOutcome,
} from "./domain/beneficiary.js";
export {
  Beneficiary,
  DEFAULT_DUPLICATE_WINDOW_DAYS,
  isAidType,
  isBeneficiaryCategory,
  isProviderType,
} from "./domain/beneficiary.js";

export type { BeneficiaryRepository } from "./application/ports.js";

export {
  RegisterBeneficiary,
  type RegisterBeneficiaryDeps,
  type RegisterBeneficiaryInput,
  type RegisterBeneficiaryOutput,
} from "./application/register-beneficiary.js";

export {
  RecordAid,
  type RecordAidDeps,
  type RecordAidInput,
  type RecordAidOutput,
} from "./application/record-aid.js";

export {
  ScheduleFollowUp,
  type ScheduleFollowUpDeps,
  type ScheduleFollowUpInput,
  type ScheduleFollowUpOutput,
} from "./application/schedule-follow-up.js";

export {
  CompleteFollowUp,
  type CompleteFollowUpDeps,
  type CompleteFollowUpInput,
  type CompleteFollowUpOutput,
} from "./application/complete-follow-up.js";

export {
  ListOverdueFollowUps,
  type ListOverdueFollowUpsDeps,
  type OverdueFollowUp,
} from "./application/list-overdue-follow-ups.js";

export { InMemoryBeneficiaryRepository } from "./adapters/in-memory-beneficiary-repository.js";
