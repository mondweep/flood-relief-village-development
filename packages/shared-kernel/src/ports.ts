import type { DomainEvent } from "./events.js";

/** Outbound port: publish domain events raised by a use case. */
export interface EventPublisher {
  publish(events: DomainEvent[]): Promise<void>;
}

/** Outbound port: current time — injected so use cases are deterministic under test. */
export interface Clock {
  now(): Date;
}

/** Outbound port: identifier generation — injected for deterministic tests. */
export interface IdGenerator {
  next(): string;
}
