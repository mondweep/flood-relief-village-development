import { type Result, type Clock, type EventPublisher, type VillageId, ok, geoPoint } from '../../../shared/index.js';
import { type Village, createVillage } from '../domain/village.js';
import { demographics, type DemographicsInput } from '../domain/demographics.js';
import { villageRegistered } from '../domain/events.js';
import type { VillageRepository } from './ports.js';

/** FR-VR-1: register a village with name, district, geo-location and demographics. */
export interface RegisterVillageInput {
  readonly id: VillageId;
  readonly name: string;
  readonly district: string;
  readonly location: { readonly lat: number; readonly lng: number };
  readonly demographics: DemographicsInput;
}

export interface RegisterVillageDeps {
  readonly repository: VillageRepository;
  readonly publisher: EventPublisher;
  readonly clock: Clock;
}

export async function registerVillage(
  input: RegisterVillageInput,
  deps: RegisterVillageDeps,
): Promise<Result<Village>> {
  const locationResult = geoPoint(input.location.lat, input.location.lng);
  if (!locationResult.ok) return locationResult;

  const demographicsResult = demographics(input.demographics);
  if (!demographicsResult.ok) return demographicsResult;

  const at = deps.clock.now();
  const villageResult = createVillage({
    id: input.id,
    name: input.name,
    district: input.district,
    location: locationResult.value,
    demographics: demographicsResult.value,
    at,
  });
  if (!villageResult.ok) return villageResult;

  const village = villageResult.value;
  await deps.repository.save(village);
  await deps.publisher.publish([villageRegistered(village, at)]);
  return ok(village);
}
