import { err, ok, villageId, type Result } from "@afrip/shared-kernel";
import type { DamageAssessment, GeoCoordinates, Severity, Village } from "../domain/village.js";
import type { VillageRepository } from "./ports.js";

export interface GetVillageProfileInput {
  villageId: string;
}

export interface VillageProfile {
  id: string;
  name: string;
  district: string;
  state: string;
  geo: GeoCoordinates;
  population: number;
  households: number;
  affectedFamilies: number;
  severity: Severity;
  damageAssessments: readonly DamageAssessment[];
  latestDamageAssessment: DamageAssessment | null;
}

export interface GetVillageProfileDeps {
  repository: VillageRepository;
}

/**
 * The one projection of the aggregate onto the wire shape. Shared so a command
 * that returns the amended profile (CorrectVillageProfile) cannot drift from
 * what the read returns.
 */
export function toVillageProfile(village: Village): VillageProfile {
  return {
    id: village.id,
    name: village.name,
    district: village.district,
    state: village.state,
    geo: village.geo,
    population: village.population,
    households: village.households,
    affectedFamilies: village.affectedFamilies,
    severity: village.severity,
    damageAssessments: village.damageAssessments,
    latestDamageAssessment: village.latestDamageAssessment,
  };
}

export class GetVillageProfile {
  constructor(private readonly deps: GetVillageProfileDeps) {}

  async execute(input: GetVillageProfileInput): Promise<Result<VillageProfile>> {
    const idResult = villageId(input.villageId);
    if (!idResult.ok) return err(idResult.error);

    const village = await this.deps.repository.findById(idResult.value);
    if (!village) return err(`Village not found: ${input.villageId}`);

    return ok(toVillageProfile(village));
  }
}
