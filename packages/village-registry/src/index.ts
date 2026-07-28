export type {
  DamageAssessment,
  DamageAssessmentInput,
  GeoCoordinates,
  Severity,
  VillageCreateProps,
} from "./domain/village.js";
export { Village, isSeverity } from "./domain/village.js";

export type { VillageRepository } from "./application/ports.js";

export {
  RegisterVillage,
  type RegisterVillageDeps,
  type RegisterVillageInput,
  type RegisterVillageOutput,
} from "./application/register-village.js";

export {
  RecordDamageAssessment,
  type RecordDamageAssessmentDeps,
  type RecordDamageAssessmentInput,
  type RecordDamageAssessmentOutput,
} from "./application/record-damage-assessment.js";

export {
  UpdateSeverity,
  type UpdateSeverityDeps,
  type UpdateSeverityInput,
  type UpdateSeverityOutput,
} from "./application/update-severity.js";

export {
  GetVillageProfile,
  type GetVillageProfileDeps,
  type GetVillageProfileInput,
  type VillageProfile,
} from "./application/get-village-profile.js";

export {
  ListVillagesBySeverity,
  type ListVillagesBySeverityDeps,
  type VillageSummary,
} from "./application/list-villages-by-severity.js";

export { InMemoryVillageRepository } from "./adapters/in-memory-village-repository.js";
