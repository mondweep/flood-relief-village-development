export type {
  CoordinateSource,
  DamageAssessment,
  DamageAssessmentInput,
  GeoCoordinates,
  Severity,
  UpdateDemographicsInput,
  VillageCreateProps,
} from "./domain/village.js";
export {
  COORDINATE_SOURCES_BY_TRUST,
  SURVEYED_COORDINATE_SOURCES,
  Village,
  coordinateTrust,
  isAtLeastAsTrustedAs,
  isCoordinateSource,
  isSeverity,
  needsSurveyedPosition,
} from "./domain/village.js";

export type {
  GeocodeCandidate,
  GeocodingService,
  LatLng,
  PlaceDescription,
  PlaceQuery,
  VillageRepository,
} from "./application/ports.js";
export { confirmCandidate } from "./application/ports.js";

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
  CorrectVillageProfile,
  type CorrectVillageProfileDeps,
  type CorrectVillageProfileInput,
  type CorrectVillageProfileOutput,
  type CorrectableField,
  type CorrectableValue,
  type FieldCorrection,
  type ProfileCorrections,
} from "./application/correct-village-profile.js";

export {
  GetVillageProfile,
  toVillageProfile,
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

export {
  DEFAULT_FAKE_PLACES,
  FakeGeocoding,
  type FakePlace,
} from "./adapters/fake-geocoding.js";

export {
  NominatimGeocoding,
  type FetchLike,
  type FetchResponse,
  type NominatimGeocodingOptions,
} from "./adapters/nominatim-geocoding.js";

export {
  DAMAGE_ASSESSMENTS_TABLE,
  SupabaseVillageRepository,
  VILLAGES_TABLE,
  fromRow as villageFromRow,
  toDamageAssessmentRows,
  toRow as villageToRow,
  type DamageAssessmentRow,
  type VillageRow,
} from "./adapters/supabase-village-repository.js";
