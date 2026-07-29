import { err, ok, type Result, type VillageId } from "@afrip/shared-kernel";

export type Severity = "minor" | "moderate" | "severe" | "critical";

const SEVERITIES: readonly Severity[] = ["minor", "moderate", "severe", "critical"];

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

/**
 * How a position was obtained, most trusted first (ADR 0012 §1).
 *
 * The ordering lives HERE, in the declaration of the type itself, rather than
 * in comparisons scattered across callers. Two things follow: the enum and its
 * trust order cannot drift apart, and every question about relative provenance
 * ("is this better than what we had?", "does this still need surveying?") is
 * answered by an index into one list.
 *
 * The distinction is domain-meaningful, not bookkeeping: a district officer
 * deciding where to send a boat needs to know which positions were surveyed and
 * which were inferred from a name by a geocoder that, for rural Assam, is
 * frequently and confidently wrong (ADR 0012 §Context 1).
 */
export const COORDINATE_SOURCES_BY_TRUST = [
  "device_gps",
  "map_pin",
  "geocoded",
  "manual_entry",
] as const;

export type CoordinateSource = (typeof COORDINATE_SOURCES_BY_TRUST)[number];

export function isCoordinateSource(value: unknown): value is CoordinateSource {
  return typeof value === "string" && (COORDINATE_SOURCES_BY_TRUST as readonly string[]).includes(value);
}

/** 0 is the most trusted. Lower compares better, like a finishing position. */
export function coordinateTrust(source: CoordinateSource): number {
  return COORDINATE_SOURCES_BY_TRUST.indexOf(source);
}

export function isAtLeastAsTrustedAs(a: CoordinateSource, b: CoordinateSource): boolean {
  return coordinateTrust(a) <= coordinateTrust(b);
}

/**
 * The two ways a human establishes a position: standing in the village with a
 * GNSS receiver, or pointing at the spot on a map. Everything else is inferred.
 */
export const SURVEYED_COORDINATE_SOURCES: readonly CoordinateSource[] = ["device_gps", "map_pin"];

/**
 * "Which villages still need a surveyed position?" — the operational question
 * ADR 0012 §Consequences names as the feature's real payoff. Giving the domain
 * the vocabulary for it is the point of the enum; a caller that has to write
 * `geo.source === "geocoded" || geo.source === "manual_entry"` has already lost
 * the benefit.
 */
export function needsSurveyedPosition(geo: GeoCoordinates): boolean {
  return !SURVEYED_COORDINATE_SOURCES.includes(geo.source);
}

export interface GeoCoordinates {
  readonly lat: number;
  readonly lng: number;
  /**
   * REQUIRED. An optional provenance field would default to absent for every
   * existing row and every lazy caller, which is precisely the ambiguity this
   * decision exists to remove (ADR 0012 §1).
   */
  readonly source: CoordinateSource;
  /** Device GPS reports this; the other three sources do not. */
  readonly accuracyMetres?: number;
  /** ISO instant. */
  readonly capturedAt?: string;
}

/**
 * Deliberately stricter than `Date.parse`, which in V8 happily accepts `"2024"`,
 * `"March"` and a good deal else. A provenance timestamp that cannot be compared
 * to another provenance timestamp is not worth storing.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function validateGeo(geo: GeoCoordinates): string | null {
  if (geo.lat < -90 || geo.lat > 90) return "geo.lat must be between -90 and 90";
  if (geo.lng < -180 || geo.lng > 180) return "geo.lng must be between -180 and 180";
  if (!isCoordinateSource(geo.source)) {
    return `geo.source must be one of ${COORDINATE_SOURCES_BY_TRUST.join(", ")}`;
  }
  if (geo.accuracyMetres !== undefined) {
    if (!Number.isFinite(geo.accuracyMetres) || geo.accuracyMetres <= 0) {
      return "geo.accuracyMetres must be a positive finite number when present";
    }
  }
  if (geo.capturedAt !== undefined && !isIsoInstant(geo.capturedAt)) {
    return "geo.capturedAt must be an ISO instant when present";
  }
  return null;
}

function isIsoInstant(value: string): boolean {
  return ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

export interface DamageAssessment {
  readonly assessedAt: string;
  readonly housesDamaged: number;
  readonly schoolsDamaged: number;
  readonly healthCentresDamaged: number;
  readonly waterSourcesDamaged: number;
  readonly agricultureHectaresLost: number;
  readonly livestockLost: number;
  readonly notes?: string;
}

export type DamageAssessmentInput = DamageAssessment;

export interface VillageCreateProps {
  id: VillageId;
  name: string;
  district: string;
  state: string;
  geo: GeoCoordinates;
  population: number;
  households: number;
  affectedFamilies: number;
  severity: Severity;
}

function isNonNegativeInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

function isNonNegativeNumber(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

function validateVillageProps(props: VillageCreateProps): string | null {
  if (props.name.trim().length === 0) return "name must not be empty";
  if (props.district.trim().length === 0) return "district must not be empty";
  if (props.state.trim().length === 0) return "state must not be empty";
  const geoError = validateGeo(props.geo);
  if (geoError) return geoError;
  if (!isNonNegativeInt(props.population)) return "population must be a non-negative integer";
  if (!isNonNegativeInt(props.households)) return "households must be a non-negative integer";
  if (!isNonNegativeInt(props.affectedFamilies)) return "affectedFamilies must be a non-negative integer";
  if (props.affectedFamilies > props.households) {
    return "affectedFamilies must not exceed households";
  }
  if (!isSeverity(props.severity)) return `invalid severity: ${String(props.severity)}`;
  return null;
}

function validateDamageAssessmentInput(input: DamageAssessmentInput): string | null {
  if (!isNonNegativeInt(input.housesDamaged)) return "housesDamaged must be a non-negative integer";
  if (!isNonNegativeInt(input.schoolsDamaged)) return "schoolsDamaged must be a non-negative integer";
  if (!isNonNegativeInt(input.healthCentresDamaged)) {
    return "healthCentresDamaged must be a non-negative integer";
  }
  if (!isNonNegativeInt(input.waterSourcesDamaged)) {
    return "waterSourcesDamaged must be a non-negative integer";
  }
  if (!isNonNegativeNumber(input.agricultureHectaresLost)) {
    return "agricultureHectaresLost must be a non-negative number";
  }
  if (!isNonNegativeInt(input.livestockLost)) return "livestockLost must be a non-negative integer";
  if (input.assessedAt.trim().length === 0) return "assessedAt must not be empty";
  return null;
}

export interface UpdateDemographicsInput {
  name?: string;
  district?: string;
  state?: string;
  geo?: GeoCoordinates;
  population?: number;
  households?: number;
  affectedFamilies?: number;
}

export class Village {
  readonly id: VillageId;
  severity: Severity;
  private _name: string;
  private _district: string;
  private _state: string;
  private _geo: GeoCoordinates;
  private _population: number;
  private _households: number;
  private _affectedFamilies: number;
  private readonly _damageAssessments: DamageAssessment[];

  private constructor(props: VillageCreateProps, damageAssessments: DamageAssessment[]) {
    this.id = props.id;
    this._name = props.name;
    this._district = props.district;
    this._state = props.state;
    this._geo = { ...props.geo };
    this._population = props.population;
    this._households = props.households;
    this._affectedFamilies = props.affectedFamilies;
    this.severity = props.severity;
    this._damageAssessments = damageAssessments;
  }

  static create(props: VillageCreateProps): Result<Village> {
    const error = validateVillageProps(props);
    if (error) return err(error);
    return ok(new Village(props, []));
  }

  get name(): string {
    return this._name;
  }

  get district(): string {
    return this._district;
  }

  get state(): string {
    return this._state;
  }

  get geo(): GeoCoordinates {
    return { ...this._geo };
  }

  get population(): number {
    return this._population;
  }

  get households(): number {
    return this._households;
  }

  get affectedFamilies(): number {
    return this._affectedFamilies;
  }

  /**
   * Updates demographic fields, re-running the same validation as create()
   * (including affectedFamilies <= households) against the merged state.
   */
  updateDemographics(input: UpdateDemographicsInput): Result<void> {
    const next: VillageCreateProps = {
      id: this.id,
      name: input.name ?? this._name,
      district: input.district ?? this._district,
      state: input.state ?? this._state,
      geo: input.geo ?? this._geo,
      population: input.population ?? this._population,
      households: input.households ?? this._households,
      affectedFamilies: input.affectedFamilies ?? this._affectedFamilies,
      severity: this.severity,
    };
    const error = validateVillageProps(next);
    if (error) return err(error);
    this._name = next.name;
    this._district = next.district;
    this._state = next.state;
    this._geo = { ...next.geo };
    this._population = next.population;
    this._households = next.households;
    this._affectedFamilies = next.affectedFamilies;
    return ok(undefined);
  }

  /** Copies — mutating the returned array or its elements does not affect the aggregate. */
  get damageAssessments(): readonly DamageAssessment[] {
    return this._damageAssessments.map((assessment) => ({ ...assessment }));
  }

  get latestDamageAssessment(): DamageAssessment | null {
    const latest = this._damageAssessments[this._damageAssessments.length - 1];
    return latest ? { ...latest } : null;
  }

  recordDamageAssessment(input: DamageAssessmentInput): Result<DamageAssessment> {
    const error = validateDamageAssessmentInput(input);
    if (error) return err(error);
    const assessment: DamageAssessment = { ...input };
    this._damageAssessments.push(assessment);
    return ok({ ...assessment });
  }

  updateSeverity(severity: Severity): Result<{ previous: Severity }> {
    if (!isSeverity(severity)) return err(`invalid severity: ${String(severity)}`);
    const previous = this.severity;
    this.severity = severity;
    return ok({ previous });
  }
}
