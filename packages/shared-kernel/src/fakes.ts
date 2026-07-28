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

  subscribe(eventName: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
  }

  async publish(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const handler of this.handlers.get(event.name) ?? []) {
        await handler(event);
      }
    }
  }
}
