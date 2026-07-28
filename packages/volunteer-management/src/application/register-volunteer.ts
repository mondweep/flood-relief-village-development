import {
  err,
  ok,
  volunteerId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type IdGenerator,
  type Result,
} from "@afrip/shared-kernel";
import { Volunteer } from "../domain/volunteer.js";
import type { VolunteerRepository } from "./ports.js";

export interface RegisterVolunteerInput {
  name: string;
  skills: string[];
  languages: string[];
  location: string;
}

export interface RegisterVolunteerOutput {
  volunteerId: string;
}

export interface RegisterVolunteerDeps {
  repository: VolunteerRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  eventPublisher: EventPublisher;
}

export class RegisterVolunteer {
  constructor(private readonly deps: RegisterVolunteerDeps) {}

  async execute(input: RegisterVolunteerInput): Promise<Result<RegisterVolunteerOutput>> {
    const idResult = volunteerId(this.deps.idGenerator.next());
    if (!idResult.ok) return err(idResult.error);

    const volunteerResult = Volunteer.create({
      id: idResult.value,
      name: input.name,
      skills: input.skills,
      languages: input.languages,
      location: input.location,
      availability: "available",
    });
    if (!volunteerResult.ok) return err(volunteerResult.error);

    const volunteer = volunteerResult.value;
    await this.deps.repository.save(volunteer);

    const payload: Record<string, unknown> = {
      volunteerId: volunteer.id,
    };
    const event: DomainEvent = {
      name: "volunteer.registered.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({ volunteerId: volunteer.id });
  }
}
