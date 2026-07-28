import { type Result, ok, err } from '../../../shared/index.js';

/** Demographics value object (FR-VR-1): affectedFamilies must not exceed households. */
export interface Demographics {
  readonly population: number;
  readonly households: number;
  readonly affectedFamilies: number;
}

export type DemographicsInput = Demographics;

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function demographics(input: DemographicsInput): Result<Demographics> {
  if (!nonNegativeInteger(input.population)) {
    return err('DEMOGRAPHICS_POPULATION_INVALID', `population must be a non-negative integer, got ${input.population}`);
  }
  if (!nonNegativeInteger(input.households)) {
    return err('DEMOGRAPHICS_HOUSEHOLDS_INVALID', `households must be a non-negative integer, got ${input.households}`);
  }
  if (!nonNegativeInteger(input.affectedFamilies)) {
    return err(
      'DEMOGRAPHICS_AFFECTED_FAMILIES_INVALID',
      `affectedFamilies must be a non-negative integer, got ${input.affectedFamilies}`,
    );
  }
  if (input.affectedFamilies > input.households) {
    return err(
      'DEMOGRAPHICS_AFFECTED_EXCEEDS_HOUSEHOLDS',
      `affectedFamilies (${input.affectedFamilies}) cannot exceed households (${input.households})`,
    );
  }
  return ok({
    population: input.population,
    households: input.households,
    affectedFamilies: input.affectedFamilies,
  });
}
