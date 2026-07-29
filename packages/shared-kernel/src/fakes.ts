import type { DomainEvent } from "./events.js";
import type { Clock, EventPublisher, IdGenerator } from "./ports.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * DAY_MS);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix: string) {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}

export class CapturingEventPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];

  async publish(events: DomainEvent[]): Promise<void> {
    this.published.push(...events);
  }

  eventNames(): string[] {
    return this.published.map((e) => e.name);
  }
}

export type EventHandler = (event: DomainEvent) => Promise<void>;

/** Synchronous in-process event bus — the MVP EventPublisher adapter (ADR 0005). */
export class InMemoryEventBus implements EventPublisher {
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly allHandlers: EventHandler[] = [];

  subscribe(eventName: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
  }

  /**
   * Subscribes to EVERY event, whatever its name (ADR 0011).
   *
   * Added for the audit log, and the wildcard is the point rather than a
   * convenience: an audit writer that had to name the events it cared about
   * would silently omit the events nobody remembered to add to its list, and a
   * gap in an audit trail is invisible by construction — you cannot see the
   * record that was never written. A tenth bounded context is audited the day it
   * is wired, without anyone deciding to audit it.
   *
   * Handlers run AFTER the name-keyed ones for a given event, and are awaited
   * like them, so a slow audit write back-pressures the request rather than
   * being dropped. ADR 0011 is explicit that a lost audit row is worse than a
   * slow response.
   */
  subscribeAll(handler: EventHandler): void {
    this.allHandlers.push(handler);
  }

  async publish(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const handler of this.handlers.get(event.name) ?? []) {
        await handler(event);
      }
      for (const handler of this.allHandlers) {
        await handler(event);
      }
    }
  }
}
