import {
  err,
  ok,
  villageId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
} from "@afrip/shared-kernel";
import type { GeoCoordinates, UpdateDemographicsInput } from "../domain/village.js";
import { toVillageProfile, type VillageProfile } from "./get-village-profile.js";
import type { VillageRepository } from "./ports.js";

/**
 * Correction — "our record was wrong" — as distinct from an observation
 * (`RecordDamageAssessment`) or a transition (`UpdateSeverity`). See ADR 0013.
 *
 * Two things make this different from a generic field update:
 *  - `reason` is required. An unexplained edit to a population figure is
 *    indistinguishable from a mistake or a manipulation six months later.
 *  - the emitted event carries `from` AND `to` for every field that moved,
 *    which is the shape ADR 0011 noted was missing from most mutation events.
 */

/** Fields the correction route may amend. Severity is deliberately absent — it is a transition. */
export type CorrectableField =
  | "name"
  | "district"
  | "state"
  | "geo"
  | "population"
  | "households"
  | "affectedFamilies";

export type CorrectableValue = string | number | GeoCoordinates;

export interface FieldCorrection {
  readonly from: CorrectableValue;
  readonly to: CorrectableValue;
}

/** Only fields that genuinely moved appear here. */
export type ProfileCorrections = Partial<Record<CorrectableField, FieldCorrection>>;

export interface CorrectVillageProfileInput {
  villageId: string;
  name?: string;
  district?: string;
  state?: string;
  geo?: GeoCoordinates;
  population?: number;
  households?: number;
  affectedFamilies?: number;
  /** Required, free text. Not an enum — the interesting reasons are the unanticipated ones. */
  reason: string;
}

export interface CorrectVillageProfileOutput {
  villageId: string;
  changed: ProfileCorrections;
  reason: string;
  /** The amended profile, so a caller need not re-read to render the result. */
  profile: VillageProfile;
}

export interface CorrectVillageProfileDeps {
  repository: VillageRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

/**
 * Provenance counts as part of the value (ADR 0012 §1), so re-recording the
 * same point with a better source IS a correction. "The pin was right, but it
 * was a geocoder's guess and now someone has stood there with a GPS" changes
 * what the record asserts, and flips the village out of the pending-survey set
 * — losing that to a lat/lng-only comparison would make the surveyed/inferred
 * distinction uncorrectable.
 */
function sameGeo(a: GeoCoordinates, b: GeoCoordinates): boolean {
  return (
    a.lat === b.lat &&
    a.lng === b.lng &&
    a.source === b.source &&
    a.accuracyMetres === b.accuracyMetres &&
    a.capturedAt === b.capturedAt
  );
}

export class CorrectVillageProfile {
  constructor(private readonly deps: CorrectVillageProfileDeps) {}

  async execute(input: CorrectVillageProfileInput): Promise<Result<CorrectVillageProfileOutput>> {
    const idResult = villageId(input.villageId);
    if (!idResult.ok) return err(idResult.error);

    const reason = input.reason.trim();
    if (reason.length === 0) return err("reason must not be empty");

    const village = await this.deps.repository.findById(idResult.value);
    if (!village) return err(`Village not found: ${input.villageId}`);

    // Computed before the aggregate is touched — afterwards the `from` side is gone.
    const changed: ProfileCorrections = {};
    if (input.name !== undefined && input.name !== village.name) {
      changed.name = { from: village.name, to: input.name };
    }
    if (input.district !== undefined && input.district !== village.district) {
      changed.district = { from: village.district, to: input.district };
    }
    if (input.state !== undefined && input.state !== village.state) {
      changed.state = { from: village.state, to: input.state };
    }
    if (input.geo !== undefined && !sameGeo(input.geo, village.geo)) {
      changed.geo = { from: village.geo, to: { ...input.geo } };
    }
    if (input.population !== undefined && input.population !== village.population) {
      changed.population = { from: village.population, to: input.population };
    }
    if (input.households !== undefined && input.households !== village.households) {
      changed.households = { from: village.households, to: input.households };
    }
    if (input.affectedFamilies !== undefined && input.affectedFamilies !== village.affectedFamilies) {
      changed.affectedFamilies = { from: village.affectedFamilies, to: input.affectedFamilies };
    }

    // A correction that corrects nothing is noise in the audit log — and noise
    // there is not harmless, it is what makes the real corrections hard to find.
    if (Object.keys(changed).length === 0) {
      return err("correction must change at least one field");
    }

    // The aggregate owns the rules (affectedFamilies <= households, non-negative
    // integers, non-empty names); this use case never restates them.
    const demographics: UpdateDemographicsInput = {};
    if (changed.name) demographics.name = input.name;
    if (changed.district) demographics.district = input.district;
    if (changed.state) demographics.state = input.state;
    if (changed.geo) demographics.geo = input.geo;
    if (changed.population) demographics.population = input.population;
    if (changed.households) demographics.households = input.households;
    if (changed.affectedFamilies) demographics.affectedFamilies = input.affectedFamilies;

    const updateResult = village.updateDemographics(demographics);
    if (!updateResult.ok) return err(updateResult.error);

    await this.deps.repository.save(village);

    const payload: Record<string, unknown> = { villageId: village.id, changed, reason };
    const event: DomainEvent = {
      name: "village.profile-corrected.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ villageId: village.id, changed, reason, profile: toVillageProfile(village) });
  }
}
