import {
  err,
  ok,
  type DomainEvent,
  type EventPublisher,
  type Result,
  type VolunteerId,
} from "@afrip/shared-kernel";
import type { Availability } from "../domain/volunteer.js";
import type { VolunteerRepository } from "./ports.js";

export interface SetAvailabilityInput {
  volunteerId: VolunteerId;
  availability: Availability;
}

export interface SetAvailabilityOutput {
  volunteerId: string;
  previousAvailability: Availability;
}

export interface SetAvailabilityDeps {
  repository: VolunteerRepository;
  eventPublisher: EventPublisher;
  clock: { now(): Date };
}

export class SetAvailability {
  constructor(private readonly deps: SetAvailabilityDeps) {}

  async execute(input: SetAvailabilityInput): Promise<Result<SetAvailabilityOutput>> {
    const volunteer = await this.deps.repository.findById(input.volunteerId);
    if (!volunteer) return err("volunteer not found");

    const result = volunteer.setAvailability(input.availability);
    if (!result.ok) return err(result.error);

    await this.deps.repository.save(volunteer);

    const payload: Record<string, unknown> = {
      volunteerId: volunteer.id,
      availability: input.availability,
      previousAvailability: result.value.previous,
    };
    const event: DomainEvent = {
      name: "volunteer.availability-changed.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ volunteerId: volunteer.id, previousAvailability: result.value.previous });
  }
}
