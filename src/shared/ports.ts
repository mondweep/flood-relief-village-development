import type { DomainEvent } from './events.js';

/** Port: time is injected so domain rules about deadlines/windows are testable. */
export interface Clock {
  now(): Date;
}

/** Port: transactional outbox publisher (ADR-006). */
export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>;
}
