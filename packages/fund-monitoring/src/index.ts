// Domain
export {
  FundedProject,
  isFundSource,
  isProjectCategory,
  type Anomaly,
  type AnomalyDetectionInput,
  type AnomalyType,
  type Expenditure,
  type FundSource,
  type FundedProjectCreateProps,
  type ProjectCategory,
  type ProjectStatus,
} from "./domain/funded-project.js";

// Application — ports
export type { ProjectRepository } from "./application/ports.js";

// Application — use cases
export {
  SanctionProject,
  type SanctionProjectDeps,
  type SanctionProjectInput,
  type SanctionProjectOutput,
} from "./application/sanction-project.js";
export {
  ReleaseFunds,
  type ReleaseFundsDeps,
  type ReleaseFundsInput,
  type ReleaseFundsOutput,
} from "./application/release-funds.js";
export {
  RecordExpenditure,
  type RecordExpenditureDeps,
  type RecordExpenditureInput,
  type RecordExpenditureOutput,
} from "./application/record-expenditure.js";
export {
  CompleteProject,
  type CompleteProjectDeps,
  type CompleteProjectInput,
  type CompleteProjectOutput,
} from "./application/complete-project.js";
export {
  VerifyProject,
  type VerifyProjectDeps,
  type VerifyProjectInput,
  type VerifyProjectOutput,
} from "./application/verify-project.js";
export {
  DetectAnomalies,
  DEFAULT_STALLED_AFTER_DAYS,
  type DetectAnomaliesDeps,
  type DetectAnomaliesInput,
  type DetectAnomaliesOutput,
} from "./application/detect-anomalies.js";

// Adapters
export { InMemoryProjectRepository } from "./adapters/in-memory-project-repository.js";
