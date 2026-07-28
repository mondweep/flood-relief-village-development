import {
  err,
  ok,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  type Result,
  type VolunteerId,
} from "@afrip/shared-kernel";
import type { VolunteerRepository } from "./ports.js";

export interface LogHoursInput {
  volunteerId: VolunteerId;
  assignmentId: string;
  hours: number;
}

export interface LogHoursOutput {
  volunteerId: string;
  assignmentId: string;
  hoursLogged: number;
}

export interface LogHoursDeps {
  repository: VolunteerRepository;
  clock: Clock;
  eventPublisher: EventPublisher;
}

export class LogHours {
  constructor(private readonly deps: LogHoursDeps) {}

  async execute(input: LogHoursInput): Promise<Result<LogHoursOutput>> {
    const volunteer = await this.deps.repository.findById(input.volunteerId);
    if (!volunteer) return err("volunteer not found");

    const result = volunteer.logHours(input.assignmentId, input.hours);
    if (!result.ok) return err(result.error);

    await this.deps.repository.save(volunteer);

    const payload: Record<string, unknown> = {
      volunteerId: volunteer.id,
      assignmentId: input.assignmentId,
      hours: input.hours,
    };
    const event: DomainEvent = {
      name: "volunteer.hours-logged.v1",
      occurredAt: this.deps.clock.now().toISOString(),
      payload,
    };
    await this.deps.eventPublisher.publish([event]);

    return ok({
      volunteerId: volunteer.id,
      assignmentId: input.assignmentId,
      hoursLogged: input.hours,
    });
  }
}
