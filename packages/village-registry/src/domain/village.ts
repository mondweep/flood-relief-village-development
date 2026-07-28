import { err, ok, type Result, type VillageId } from "@afrip/shared-kernel";

export type Severity = "minor" | "moderate" | "severe" | "critical";

const SEVERITIES: readonly Severity[] = ["minor", "moderate", "severe", "critical"];

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

export interface GeoCoordinates {
  readonly lat: number;
  readonly lng: number;
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
  if (props.geo.lat < -90 || props.geo.lat > 90) return "geo.lat must be between -90 and 90";
  if (props.geo.lng < -180 || props.geo.lng > 180) return "geo.lng must be between -180 and 180";
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

export class Village {
  readonly id: VillageId;
  name: string;
  district: string;
  state: string;
  geo: GeoCoordinates;
  population: number;
  households: number;
  affectedFamilies: number;
  severity: Severity;
  private readonly _damageAssessments: DamageAssessment[];

  private constructor(props: VillageCreateProps, damageAssessments: DamageAssessment[]) {
    this.id = props.id;
    this.name = props.name;
    this.district = props.district;
    this.state = props.state;
    this.geo = props.geo;
    this.population = props.population;
    this.households = props.households;
    this.affectedFamilies = props.affectedFamilies;
    this.severity = props.severity;
    this._damageAssessments = damageAssessments;
  }

  static create(props: VillageCreateProps): Result<Village> {
    const error = validateVillageProps(props);
    if (error) return err(error);
    return ok(new Village(props, []));
  }

  get damageAssessments(): readonly DamageAssessment[] {
    return this._damageAssessments;
  }

  get latestDamageAssessment(): DamageAssessment | null {
    if (this._damageAssessments.length === 0) return null;
    return this._damageAssessments[this._damageAssessments.length - 1] ?? null;
  }

  recordDamageAssessment(input: DamageAssessmentInput): Result<DamageAssessment> {
    const error = validateDamageAssessmentInput(input);
    if (error) return err(error);
    const assessment: DamageAssessment = { ...input };
    this._damageAssessments.push(assessment);
    return ok(assessment);
  }

  updateSeverity(severity: Severity): Result<{ previous: Severity }> {
    if (!isSeverity(severity)) return err(`invalid severity: ${String(severity)}`);
    const previous = this.severity;
    this.severity = severity;
    return ok({ previous });
  }
}
