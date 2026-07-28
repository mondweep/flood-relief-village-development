import {
  err,
  ok,
  villageId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";
import { Village, type GeoCoordinates, type Severity } from "../domain/village.js";
import type { VillageRepository } from "./ports.js";

export interface RegisterVillageInput {
  name: string;
  district: string;
  state: string;
  geo: GeoCoordinates;
  population: number;
  households: number;
  affectedFamilies: number;
  severity: Severity;
}

export interface RegisterVillageOutput {
  villageId: string;
}

export interface RegisterVillageDeps {
  repository: VillageRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class RegisterVillage {
  constructor(private readonly deps: RegisterVillageDeps) {}

  async execute(input: RegisterVillageInput): Promise<Result<RegisterVillageOutput>> {
    const idResult = villageId(this.deps.idGenerator.next());
    if (!idResult.ok) return err(idResult.error);

    const villageResult = Village.create({
      id: idResult.value,
      name: input.name,
      district: input.district,
      state: input.state,
      geo: input.geo,
      population: input.population,
      households: input.households,
      affectedFamilies: input.affectedFamilies,
      severity: input.severity,
    });
    if (!villageResult.ok) return err(villageResult.error);

    const village = villageResult.value;
    await this.deps.repository.save(village);

    const payload: Record<string, unknown> = {
      villageId: village.id,
      name: village.name,
      district: village.district,
      severity: village.severity,
    };
    const event: DomainEvent = {
      name: "village.registered.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ villageId: village.id });
  }
}
